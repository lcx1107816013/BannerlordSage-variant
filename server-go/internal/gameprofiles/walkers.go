package gameprofiles

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"blore/internal/report"
)

// ─────────────────────────────────────────────────────────────────────────────
// The game-dir walkers — the file-system half of src/utils/game-profiles.ts.
//
// The analysis half (sorting, selection, classification) was ported with the doctor.
// This file adds the two walkers that reach bannerlord_doctor's missing-DLL check and
// setup's import:
//
//   WalkFiles          — every regular file under a tree, FOLLOWING directory links
//   CollectDllCandidates — the official/modding/all DLL candidate lists
//
// ★ THE WALKER FOLLOWS SYMBOLIC LINKS, BY MEASUREMENT. The 2026-10-06 fix in the TS:
// withFileTypes dirents do not follow reparse points, so a mod-manager (Vortex)
// installation whose bin dirs are symlinks yielded ZERO dlls and the doctor reported 39
// false missing_declared_submodule_dll. The rule: follow the link and dispatch on the
// TARGET — directory recurses, file yields, BROKEN LINK SKIPS (a broken link is a
// different problem, not a missing DLL). The Go port uses os.Stat (which follows) on
// every non-regular dirent, mirroring the three-way dispatch.
//
// ★ JUNCTIONS AND SYMLINKS ARE NOT DISTINGUISHED HERE. The TS's entry.isSymbolicLink()
// covers both on Windows (Node reports a junction as a symlink); the Go walker below
// follows the same set. The parity README's junction notes measured the underlying
// dirent difference between the runtimes; this walker lands on the same observable
// behaviour by dispatching on the stat target instead of the dirent type.
// ─────────────────────────────────────────────────────────────────────────────

// WalkFiles mirrors walkFiles(dir): depth-first, yielding every regular file. Directory
// entries recurse; a reparse point is resolved through os.Stat and dispatched on the
// target (recursing into directories, yielding files, skipping broken links).
func WalkFiles(dir string, fn func(filePath string) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		fullPath := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if err := WalkFiles(fullPath, fn); err != nil {
				return err
			}
			continue
		}
		if entry.Type().IsRegular() {
			if err := fn(fullPath); err != nil {
				return err
			}
			continue
		}
		// A reparse point (symlink/junction): follow it. os.Stat follows; a broken
		// link fails the stat and is SKIPPED, which is the TS's `catch { continue }`.
		info, err := os.Stat(fullPath)
		if err != nil {
			continue
		}
		if info.IsDir() {
			if err := WalkFiles(fullPath, fn); err != nil {
				return err
			}
			continue
		}
		if info.Mode().IsRegular() {
			if err := fn(fullPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// DllCollectionScope mirrors DllCollectionOptions.dllScope.
type DllCollectionScope = string

const (
	DllScopeOfficial DllCollectionScope = "official"
	DllScopeModding  DllCollectionScope = "modding"
	DllScopeAll      DllCollectionScope = "all"
	DllScopeDefault  DllCollectionScope = "default"
)

// CollectDllCandidates mirrors the bannerlord profile's collectDllCandidates.
//
// The walk: every *.dll under gameDir whose normalized path contains '/bin/'. Each
// candidate is attributed by module name (official modules only) or by the root-bin
// rules (isBannerlordRootBinDll + official/modding sets). The requested scope then
// selects the list; 'default' routes through SelectDLLCandidates with the profile's
// core DLL inputs.
//
// resolve mirrors the TS's path.resolve (absolute, case-preserved); rel is
// path.relative; baseNameFn is path.basename. They are parameters for the same reason
// SelectDLLCandidates takes them: this package must not depend on a path helper owned
// by another package (F25 — one implementation, referenced not copied).
func CollectDllCandidates(
	gameDir string,
	scope DllCollectionScope,
	classify func(modulesDir string) ([]XmlModuleClassification, error),
	officialModuleIDs func() map[string]struct{},
	coreDLLInputs []string,
	resolve func(string) string,
	rel func(base, target string) string,
	baseNameFn func(string) string,
) ([]string, error) {
	if scope == "" {
		scope = DllScopeOfficial
	}

	modulesDir := filepath.Join(gameDir, "Modules")
	var moduleClassifications []XmlModuleClassification
	if info, err := os.Stat(modulesDir); err == nil && info.IsDir() {
		moduleClassifications, err = classify(modulesDir)
		if err != nil {
			return nil, err
		}
	}

	officialNames := map[string]bool{}
	officialSet := officialModuleIDs()
	for _, m := range moduleClassifications {
		if m.IsOfficial {
			officialNames[strings.ToLower(m.ModuleName)] = true
		}
	}
	_ = officialSet

	var allCandidates, officialCandidates, moddingCandidates []string

	err := WalkFiles(gameDir, func(filePath string) error {
		if !strings.HasSuffix(strings.ToLower(filePath), ".dll") {
			return nil
		}
		normalized := strings.ToLower(strings.ReplaceAll(filePath, `\`, "/"))
		if !strings.Contains(normalized, "/bin/") {
			return nil
		}
		resolvedPath := resolve(filePath)
		allCandidates = append(allCandidates, resolvedPath)

		moduleName, ok := tryGetBannerlordModuleName(gameDir, filePath, rel)
		if ok {
			if !officialNames[strings.ToLower(moduleName)] {
				return nil
			}
			officialCandidates = append(officialCandidates, resolvedPath)
			moddingCandidates = append(moddingCandidates, resolvedPath)
			return nil
		}

		if !isBannerlordRootBinDll(gameDir, filePath, rel) {
			return nil
		}
		if !IsOfficialRootBinDLL(filePath) {
			return nil
		}

		officialCandidates = append(officialCandidates, resolvedPath)
		if IsModdingRootBinDLL(filePath) {
			moddingCandidates = append(moddingCandidates, resolvedPath)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	switch scope {
	case DllScopeAll:
		return SortDLLCandidates(allCandidates, resolve), nil
	case DllScopeOfficial:
		return SortDLLCandidates(officialCandidates, resolve), nil
	case DllScopeModding:
		return SortDLLCandidates(moddingCandidates, resolve), nil
	}

	// The 'default' scope: the sorted official list narrowed to the core inputs.
	sorted := SortDLLCandidates(officialCandidates, resolve)
	return SelectDLLCandidates(gameDir, sorted, coreDLLInputs, rel, baseNameFn, resolve), nil
}

// tryGetBannerlordModuleName mirrors tryGetBannerlordModuleName: PURELY POSITIONAL —
// the first path component must be 'modules' (case-insensitive) and the second is the
// module name, whatever it is. No classification, no officialness: the CALLER gates on
// the official-module set. A dll directly under Modules/ (no second component) yields
// no module.
func tryGetBannerlordModuleName(
	gameDir, dllPath string,
	rel func(base, target string) string,
) (string, bool) {
	relPath := strings.ReplaceAll(rel(gameDir, dllPath), `\`, "/")
	parts := strings.Split(relPath, "/")

	if len(parts) == 0 || strings.ToLower(parts[0]) != "modules" {
		return "", false
	}
	if len(parts) < 2 || parts[1] == "" {
		return "", false
	}
	return parts[1], true
}

// isBannerlordRootBinDll mirrors isBannerlordRootBinDll: the relative path starts with
// 'bin/' — NOTHING MORE. The TS has no nesting-depth check; a dll three levels under
// bin/ is still a "root bin" dll by this predicate.
func isBannerlordRootBinDll(gameDir, dllPath string, rel func(base, target string) string) bool {
	relPath := strings.ToLower(strings.ReplaceAll(rel(gameDir, dllPath), `\`, "/"))
	return strings.HasPrefix(relPath, "bin/")
}

// ClassifyModulesDir drives ClassifyModule over every directory under modulesDir that
// carries a SubModule.xml, mirroring classifyBannerlordModules.
func ClassifyModulesDir(modulesDir string) ([]XmlModuleClassification, error) {
	entries, err := os.ReadDir(modulesDir)
	if err != nil {
		return nil, err
	}
	out := make([]XmlModuleClassification, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		moduleDir := filepath.Join(modulesDir, entry.Name())
		subModulePath := filepath.Join(moduleDir, "SubModule.xml")
		raw, err := os.ReadFile(subModulePath)
		if err != nil {
			continue
		}
		out = append(out, ClassifyModule(entry.Name(), "", string(raw), moduleDir))
	}

	sort.SliceStable(out, func(i, j int) bool {
		return report.CompareCodeUnits(out[i].ModuleDir, out[j].ModuleDir) < 0
	})
	return out, nil
}
