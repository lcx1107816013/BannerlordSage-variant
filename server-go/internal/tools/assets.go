// Package tools: texture and material asset discovery.
//
// WHY THIS EXISTS: the archive could already say which XML declared an item and which C#
// type consumed it, but nothing about the artwork those declarations point at. A modder
// changing a shield's look needs to get from a material id or a texture name to the file on
// disk, and that half had no tool at all.
//
// IT DOES NOT DECODE PAYLOADS. Parsing a DDS header is tractable; TPAC is a versioned
// container whose layout is not documented here, and guessing at it would produce confident
// wrong answers - the failure mode this project keeps finding elsewhere. Discovery is the
// part that can be made correct now, and it is what a modder needs first: WHICH file to open.
//
// THE TWO ANSWER KINDS STAY APART. Shipped bundles (AssetPackages/*.tpac) and loose artwork
// (GUI/, Textures/, Meshes/ with art extensions) are reported separately, because a loose
// texture is not necessarily the one the game loads - merging them would imply it is.
package tools

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// AssetKind classifies what was found.
type AssetKind string

const (
	AssetTexture AssetKind = "texture"
	AssetModel   AssetKind = "model"
	AssetPackage AssetKind = "package"
)

// TextureExtensions and friends are explicit lists so they can be audited and tested.
var (
	TextureExtensions = []string{".dds", ".png", ".jpg", ".jpeg", ".tga", ".bmp"}
	ModelExtensions   = []string{".mesh", ".fbx", ".obj", ".dae", ".gltf", ".glb"}
	PackageExtensions = []string{".tpac"}
)

// pruneDirs never hold authored assets and can be large. bin/ and .git in particular made an
// early version of this walk spend minutes inside a mod repository.
var pruneDirs = map[string]bool{
	".git": true, "node_modules": true, "bin": true, "obj": true,
	".vs": true, ".idea": true, "__pycache__": true,
}

// AssetEntry is one discovered file.
type AssetEntry struct {
	RelativePath string    `json:"relative_path"`
	AbsolutePath string    `json:"absolute_path"`
	FileName     string    `json:"file_name"`
	Extension    string    `json:"extension"`
	Kind         AssetKind `json:"kind"`
	SizeBytes    int64     `json:"size_bytes"`
	ModuleID     string    `json:"module_id"`
}

// AssetIndex is the result of a walk.
type AssetIndex struct {
	Root               string         `json:"root"`
	Entries            []AssetEntry   `json:"entries"`
	Counts             map[string]int `json:"counts"`
	SkippedDirectories []string       `json:"skipped_directories"`
	Truncated          bool           `json:"truncated"`
}

func classifyAsset(ext string) (AssetKind, bool) {
	e := strings.ToLower(ext)
	for _, x := range TextureExtensions {
		if e == x {
			return AssetTexture, true
		}
	}
	for _, x := range ModelExtensions {
		if e == x {
			return AssetModel, true
		}
	}
	for _, x := range PackageExtensions {
		if e == x {
			return AssetPackage, true
		}
	}
	return "", false
}

// IndexAssetsOptions controls IndexAssets.
type IndexAssetsOptions struct {
	// Limit stops the walk; the result reports Truncated when it was hit, because a
	// truncated index that claims to be complete is worse than no index.
	Limit int
	// ModuleID restricts the walk to one directory under Modules/.
	ModuleID string
}

// IndexAssets walks a game directory (or any module tree) collecting artwork and packages.
func IndexAssets(gameDir string, options IndexAssetsOptions) (*AssetIndex, error) {
	limit := options.Limit
	if limit <= 0 {
		limit = 5000
	}

	result := &AssetIndex{
		Root:               gameDir,
		Entries:            []AssetEntry{},
		Counts:             map[string]int{},
		SkippedDirectories: []string{},
	}

	type start struct {
		dir      string
		moduleID string
	}
	var starts []start
	modulesDir := filepath.Join(gameDir, "Modules")

	if options.ModuleID != "" {
		starts = append(starts, start{filepath.Join(modulesDir, options.ModuleID), options.ModuleID})
	} else {
		if entries, err := os.ReadDir(modulesDir); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					starts = append(starts, start{filepath.Join(modulesDir, e.Name()), e.Name()})
				}
			}
		}

		// ★ THE INSTALL-LEVEL TREE IS SEPARATE FROM THE MODULE TREES. Starting every walk
		// inside Modules/ meant artwork the game ships at the install root was invisible.
		// These are labelled "game" rather than "unknown", because they belong to a specific
		// thing and "unknown" would read as "the walker lost track".
		for _, dirName := range []string{"GUI", "Textures", "Meshes", "AssetPackages"} {
			candidate := filepath.Join(gameDir, dirName)
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				starts = append(starts, start{candidate, "game"})
			}
		}

		if len(starts) == 0 {
			starts = append(starts, start{gameDir, "unknown"})
		}
	}

	walk := func(root start) error {
		return filepath.WalkDir(root.dir, func(path string, d fs.DirEntry, err error) error {
			if result.Truncated {
				return filepath.SkipAll
			}
			if err != nil {
				// One unreadable directory is recorded rather than aborting the walk, so a
				// single bad ACL does not lose the other several thousand results.
				result.SkippedDirectories = append(result.SkippedDirectories, path)
				return nil
			}
			if d.IsDir() {
				if pruneDirs[d.Name()] && path != root.dir {
					result.SkippedDirectories = append(result.SkippedDirectories, path)
					return filepath.SkipDir
				}
				return nil
			}

			kind, ok := classifyAsset(filepath.Ext(d.Name()))
			if !ok {
				return nil
			}
			if len(result.Entries) >= limit {
				result.Truncated = true
				return filepath.SkipAll
			}

			var size int64
			if info, err := d.Info(); err == nil {
				size = info.Size()
			}

			rel, relErr := filepath.Rel(gameDir, path)
			if relErr != nil {
				rel = path
			}

			result.Entries = append(result.Entries, AssetEntry{
				RelativePath: filepath.ToSlash(rel),
				AbsolutePath: path,
				FileName:     filepath.Base(path),
				Extension:    strings.ToLower(filepath.Ext(d.Name())),
				Kind:         kind,
				SizeBytes:    size,
				ModuleID:     root.moduleID,
			})
			return nil
		})
	}

	for _, s := range starts {
		if result.Truncated {
			break
		}
		if info, err := os.Stat(s.dir); err != nil || !info.IsDir() {
			continue
		}
		if err := walk(s); err != nil {
			return nil, err
		}
	}

	for _, e := range result.Entries {
		result.Counts[string(e.Kind)]++
	}
	return result, nil
}

// FormatAssetIndex renders an index as the text report the MCP surface returns.
//
// Sorted by kind then path so the output is stable across runs - an unsorted listing makes
// every diff look like a change.
func FormatAssetIndex(index *AssetIndex, query string) string {
	entries := index.Entries
	if strings.TrimSpace(query) != "" {
		needle := strings.ToLower(strings.TrimSpace(query))
		filtered := make([]AssetEntry, 0, len(entries))
		for _, e := range entries {
			if strings.Contains(strings.ToLower(e.FileName), needle) ||
				strings.Contains(strings.ToLower(e.RelativePath), needle) ||
				strings.Contains(strings.ToLower(e.ModuleID), needle) {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
	}

	sorted := make([]AssetEntry, len(entries))
	copy(sorted, entries)
	sort.Slice(sorted, func(i, j int) bool {
		if sorted[i].Kind != sorted[j].Kind {
			return sorted[i].Kind < sorted[j].Kind
		}
		return sorted[i].RelativePath < sorted[j].RelativePath
	})

	var b strings.Builder
	fmt.Fprintf(&b, "root: %s\n", index.Root)
	fmt.Fprintf(&b, "textures: %d  models: %d  packages: %d\n",
		index.Counts[string(AssetTexture)], index.Counts[string(AssetModel)],
		index.Counts[string(AssetPackage)])

	// Shipped bundles and loose artwork are listed separately, because a loose texture is
	// not necessarily the one the game loads.
	for _, kind := range []AssetKind{AssetPackage, AssetTexture, AssetModel} {
		var group []AssetEntry
		for _, e := range sorted {
			if e.Kind == kind {
				group = append(group, e)
			}
		}
		if len(group) == 0 {
			continue
		}
		fmt.Fprintf(&b, "\n%s:\n", kind)
		for _, e := range group {
			fmt.Fprintf(&b, "  %s  [%s]  %d bytes\n", e.RelativePath, e.ModuleID, e.SizeBytes)
		}
	}

	if index.Truncated {
		b.WriteString("\nTRUNCATED: the limit was reached, this listing is partial.\n")
	}
	if len(index.SkippedDirectories) > 0 {
		fmt.Fprintf(&b, "\nskipped %d directories (build output, VCS, dependencies)\n",
			len(index.SkippedDirectories))
	}
	return b.String()
}

// assetMatchScore ranks a hit so the most obviously intended answer comes first. An exact
// filename match beats a path substring, because the common case is knowing the file's name
// and wanting its location - and that answer belongs at the top, not buried under incidental
// path matches.
func assetMatchScore(entry AssetEntry, needle string) int {
	name := strings.ToLower(entry.FileName)
	switch {
	case name == needle:
		return 100
	case strings.HasPrefix(name, needle):
		return 80
	case strings.Contains(name, needle):
		return 60
	case strings.Contains(strings.ToLower(entry.RelativePath), needle):
		return 40
	case strings.Contains(strings.ToLower(entry.ModuleID), needle):
		return 20
	default:
		return 0
	}
}

// FormatFindAsset renders the result of a lookup: best matches first, with the total indexed
// alongside so a caller can tell "not in this install" from "not in the part I searched".
func FormatFindAsset(index *AssetIndex, query string) string {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return "error: query is required\n"
	}

	type hit struct {
		entry AssetEntry
		rank  int
	}
	var hits []hit
	for _, e := range index.Entries {
		if rank := assetMatchScore(e, needle); rank > 0 {
			hits = append(hits, hit{e, rank})
		}
	}
	// Ties broken by path so repeated runs give the same order; an unstable ordering makes
	// every diff look like a change.
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].rank != hits[j].rank {
			return hits[i].rank > hits[j].rank
		}
		return hits[i].entry.RelativePath < hits[j].entry.RelativePath
	})

	var b strings.Builder
	fmt.Fprintf(&b, "query: %s\n", needle)
	fmt.Fprintf(&b, "match_count: %d\n", len(hits))
	fmt.Fprintf(&b, "total_indexed: %d\n", len(index.Entries))
	if len(hits) == 0 {
		// Distinguishing "absent" from "you searched the wrong tree" is the caller's next
		// question, so the counts above are part of the answer, not decoration.
		b.WriteString("result: no matches in the indexed tree\n")
		return b.String()
	}
	b.WriteString("\nmatches:\n")
	for _, h := range hits {
		fmt.Fprintf(&b, "  %s  [%s]  %s  %d bytes\n",
			h.entry.RelativePath, h.entry.ModuleID, h.entry.Kind, h.entry.SizeBytes)
	}
	return b.String()
}
