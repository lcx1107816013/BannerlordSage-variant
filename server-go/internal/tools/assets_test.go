package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildAssetTree lays out the same corpus the TypeScript test uses, so a divergence between
// the two implementations shows up as a failing assertion on one side rather than as a
// difference nobody looks for. The two sides are meant to answer the same questions.
func buildAssetTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()

	put := func(rel, body string) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", full, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}

	put("Modules/Native/AssetPackages/Core.tpac", strings.Repeat("t", 64))
	put("Modules/Native/GUI/Textures/Banner.DDS", strings.Repeat("d", 128))
	put("Modules/Native/GUI/Textures/banner.png", strings.Repeat("p", 32))
	put("Modules/Native/GUI/Meshes/shield.mesh", strings.Repeat("m", 16))
	put("Modules/Native/ModuleData/items.xml", "<xml/>")
	put("Modules/Native/ModuleData/notes.txt", "not art")

	// must be pruned
	put("Modules/Native/bin/Debug/Build.dds", strings.Repeat("b", 8))
	put("Modules/Native/.git/objects/loose.dds", strings.Repeat("g", 8))
	put("Modules/Native/node_modules/pkg/thing.tpac", strings.Repeat("n", 8))

	put("Modules/MercenaryGuild/GUI/Textures/guild.tga", strings.Repeat("t", 24))

	// install-level art, outside any module
	put("GUI/Textures/Install.png", strings.Repeat("i", 12))

	return root
}

func indexNames(idx *AssetIndex) map[string]bool {
	out := map[string]bool{}
	for _, e := range idx.Entries {
		out[strings.ToLower(e.FileName)] = true
	}
	return out
}

func TestIndexAssets_CollectsArtworkByKind(t *testing.T) {
	root := buildAssetTree(t)
	idx, err := IndexAssets(root, IndexAssetsOptions{Limit: 200})
	if err != nil {
		t.Fatalf("IndexAssets: %v", err)
	}

	if got := idx.Counts[string(AssetTexture)]; got != 4 {
		t.Errorf("textures = %d, want 4", got)
	}
	if got := idx.Counts[string(AssetModel)]; got != 1 {
		t.Errorf("models = %d, want 1", got)
	}
	if got := idx.Counts[string(AssetPackage)]; got != 1 {
		t.Errorf("packages = %d, want 1", got)
	}
	if idx.Truncated {
		t.Error("index reported truncated below the limit")
	}
}

func TestIndexAssets_ExtensionMatchingIsCaseInsensitive(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{Limit: 200})
	names := indexNames(idx)

	if !names["banner.dds"] {
		t.Error("uppercase .DDS was not collected")
	}
	if !names["banner.png"] {
		t.Error("lowercase .png was not collected")
	}
	if names["items.xml"] || names["notes.txt"] {
		t.Error("non-art extensions were collected")
	}
}

func TestIndexAssets_PrunesAndReportsSkippedDirectories(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{Limit: 200})
	names := indexNames(idx)

	if names["build.dds"] {
		t.Error("bin/ was not pruned")
	}
	if names["loose.dds"] {
		t.Error(".git was not pruned")
	}
	if names["thing.tpac"] {
		t.Error("node_modules was not pruned")
	}

	// A count that looks too low must have a visible reason, not a silent one.
	var sawBin, sawGit bool
	for _, p := range idx.SkippedDirectories {
		if strings.Contains(p, "bin") {
			sawBin = true
		}
		if strings.Contains(p, ".git") {
			sawGit = true
		}
	}
	if !sawBin || !sawGit {
		t.Errorf("skipped directories not reported: %v", idx.SkippedDirectories)
	}
}

func TestIndexAssets_AttributesEntriesToTheirModule(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{Limit: 200})

	byName := map[string]AssetEntry{}
	for _, e := range idx.Entries {
		byName[e.FileName] = e
	}

	if got := byName["Banner.DDS"].ModuleID; got != "Native" {
		t.Errorf("Banner.DDS module = %q, want Native", got)
	}
	if got := byName["guild.tga"].ModuleID; got != "MercenaryGuild" {
		t.Errorf("guild.tga module = %q, want MercenaryGuild", got)
	}

	loose, ok := byName["Install.png"]
	if !ok {
		t.Fatal("install-level artwork at the game root was not collected")
	}
	if loose.ModuleID != "game" {
		t.Errorf("install-level art module = %q, want game", loose.ModuleID)
	}

	for _, e := range idx.Entries {
		if strings.Contains(e.RelativePath, "\\") {
			t.Errorf("relative path uses a backslash: %q", e.RelativePath)
		}
	}
}

func TestIndexAssets_TruncationIsReported(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{Limit: 3})

	if len(idx.Entries) != 3 {
		t.Errorf("entries = %d, want 3", len(idx.Entries))
	}
	if !idx.Truncated {
		t.Error("truncation was not reported; a partial index that claims completeness is worse than none")
	}
}

func TestIndexAssets_ModuleScoping(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{ModuleID: "MercenaryGuild", Limit: 200})

	if len(idx.Entries) == 0 {
		t.Fatal("scoped walk found nothing")
	}
	for _, e := range idx.Entries {
		if e.ModuleID != "MercenaryGuild" {
			t.Errorf("scoped walk leaked module %q", e.ModuleID)
		}
	}
}

func TestIndexAssets_TreeWithNoModulesDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "Flat.dds"), []byte("f"), 0o644); err != nil {
		t.Fatal(err)
	}
	idx, err := IndexAssets(root, IndexAssetsOptions{Limit: 50})
	if err != nil {
		t.Fatalf("IndexAssets: %v", err)
	}
	if !indexNames(idx)["flat.dds"] {
		t.Error("a tree with no Modules/ directory was not walked")
	}
}

func TestFormatAssetIndex_FiltersAndSeparatesKinds(t *testing.T) {
	root := buildAssetTree(t)
	idx, _ := IndexAssets(root, IndexAssetsOptions{Limit: 200})

	all := FormatAssetIndex(idx, "")
	for _, want := range []string{"root:", "textures:", "package:", "texture:", "model:"} {
		if !strings.Contains(all, want) {
			t.Errorf("report missing %q", want)
		}
	}

	filtered := FormatAssetIndex(idx, "shield")
	if !strings.Contains(filtered, "shield.mesh") {
		t.Error("filter dropped the matching entry")
	}
	if strings.Contains(filtered, "Install.png") {
		t.Error("filter kept a non-matching entry")
	}

	// The counts line reflects the whole index, not the filtered view; a filtered listing
	// that also rewrote the counts would be reporting two different things at once.
	if !strings.Contains(filtered, "textures: 4") {
		t.Errorf("counts changed under filtering:\n%s", filtered)
	}
}

func TestClassifyAsset(t *testing.T) {
	cases := map[string]struct {
		kind AssetKind
		ok   bool
	}{
		".dds":  {AssetTexture, true},
		".DDS":  {AssetTexture, true},
		".png":  {AssetTexture, true},
		".mesh": {AssetModel, true},
		".gltf": {AssetModel, true},
		".tpac": {AssetPackage, true},
		".xml":  {"", false},
		".cs":   {"", false},
		"":      {"", false},
	}
	for ext, want := range cases {
		kind, ok := classifyAsset(ext)
		if ok != want.ok || kind != want.kind {
			t.Errorf("classifyAsset(%q) = (%q,%v), want (%q,%v)", ext, kind, ok, want.kind, want.ok)
		}
	}
}
