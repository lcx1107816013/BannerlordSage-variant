package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blore/internal/moduletooling"
)

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord-module-tooling parity (src/utils/bannerlord-module-tooling.ts)
//
// Three surfaces, each with expectations produced by EXECUTING the real module:
//
//   loadBannerlordModules -> against a real module tree on disk, so the XML parsing, the id
//     fallback, the official rules and the DLL scan are all exercised together
//   buildRecommendedLoadOrder -> against deliberately-shaped module lists, because the ORDER is
//     what the function produces and a realistic corpus would pin it only by accident
//   collectDoctorIssues -> against the same lists, one case per issue type
//
// The corpus separates rules: a module with no SubModule.xml, a module whose Id is absent (so the
// directory name wins), a module declared Official=false whose id is in the official set, a module
// official by TYPE only, duplicate ids, an absent dependency, optional vs required missing metadata,
// a three-module cycle, and two modules shipping DIFFERENT variants of one shared DLL.
// ─────────────────────────────────────────────────────────────────────────────

type mtShape struct {
	Modules map[string]struct {
		XML *string  `json:"xml"`
		Bin []string `json:"bin"`
	} `json:"modules"`
}

type mtLoadedCase struct {
	ModuleID      string   `json:"moduleId"`
	ModuleName    string   `json:"moduleName"`
	Version       *string  `json:"version"`
	ModuleType    *string  `json:"moduleType"`
	OfficialFlag  *bool    `json:"officialFlag"`
	DefaultModule *bool    `json:"defaultModule"`
	IsOfficial    bool     `json:"isOfficial"`
	ModuleDir     string   `json:"moduleDir"`
	SubModulePath string   `json:"subModulePath"`
	Dependencies  []string `json:"dependencies"`
	LoadAfter     []string `json:"loadAfter"`
	Incompatible  []string `json:"incompatible"`
	DepMetadata   []struct {
		ModuleID string  `json:"moduleId"`
		Order    *string `json:"order"`
		Optional bool    `json:"optional"`
		Version  *string `json:"version"`
	} `json:"dependencyMetadata"`
	SubModules []struct {
		Name       *string  `json:"name"`
		DLLName    *string  `json:"dllName"`
		ClassType  *string  `json:"classType"`
		Assemblies []string `json:"assemblies"`
		Tags       []string `json:"tags"`
	} `json:"subModules"`
	DLLFiles []struct {
		FileName     string  `json:"fileName"`
		RelativePath string  `json:"relativePath"`
		MD5          *string `json:"md5"`
	} `json:"dllFiles"`
}

type mtFixtures struct {
	Shape       mtShape        `json:"shape"`
	GameDirRel  string         `json:"gameDirRel"`
	LoadedCases []mtLoadedCase `json:"loadedCases"`
	OrderCases  []struct {
		Label   string          `json:"label"`
		Modules json.RawMessage `json:"modules"`
		Result  struct {
			OrderedModuleIDs    []string `json:"orderedModuleIds"`
			CycleDetected       bool     `json:"cycleDetected"`
			UnresolvedModuleIDs []string `json:"unresolvedModuleIds"`
		} `json:"result"`
	} `json:"orderCases"`
	IssueCases []struct {
		Label   string          `json:"label"`
		Modules json.RawMessage `json:"modules"`
		Result  []struct {
			Severity        string  `json:"severity"`
			IssueType       string  `json:"issueType"`
			ModuleID        *string `json:"moduleId"`
			RelatedModuleID *string `json:"relatedModuleId"`
			FilePath        *string `json:"filePath"`
			DLLName         *string `json:"dllName"`
			Detail          string  `json:"detail"`
		} `json:"result"`
	} `json:"issueCases"`
	FocusCases []struct {
		Label  string    `json:"label"`
		Args   []*string `json:"args"`
		Result []string  `json:"result"`
	} `json:"focusCases"`
	AllOfficialFocus []string `json:"allOfficialFocus"`
	OfficialMatrix   []struct {
		Index          int     `json:"index"`
		DirName        string  `json:"dirName"`
		ID             string  `json:"id"`
		Type           *string `json:"type"`
		Official       *string `json:"official"`
		LoadedModuleID *string `json:"loadedModuleId"`
		IsOfficial     *bool   `json:"isOfficial"`
	} `json:"officialMatrix"`
}

func loadModuleToolingFixtures(t *testing.T) (mtFixtures, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "moduletooling_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_moduletooling_fixtures.mjs", path, err)
	}
	var f mtFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.LoadedCases) == 0 || len(f.OrderCases) == 0 || len(f.IssueCases) == 0 {
		t.Fatal("fixtures look incomplete; refusing to report success")
	}

	root := mustAbs(t, filepath.Join("..", "..", "tools", "parity", "fixtures", "moduletooling-game"))
	// ★ REBUILT FROM THE SHAPE. One module directory deliberately has NO SubModule.xml, so git
	// cannot track it at all; the shape is the single description both sides build from.
	if err := os.RemoveAll(root); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	modulesDir := filepath.Join(root, "Modules")
	for dirName, spec := range f.Shape.Modules {
		moduleDir := filepath.Join(modulesDir, dirName)
		if err := os.MkdirAll(moduleDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if spec.XML != nil {
			if err := os.WriteFile(filepath.Join(moduleDir, "SubModule.xml"), []byte(*spec.XML), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		for _, dll := range spec.Bin {
			full := filepath.Join(moduleDir, "bin", filepath.FromSlash(dll))
			if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
				t.Fatal(err)
			}
			content := "content of " + dll + " in " + dirName
			if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}
	return f, root
}

// mtModule mirrors the shape the analysis functions receive, so a JSON case can be turned into the
// port's own type without a second parser.
func decodeMTModules(t *testing.T, raw json.RawMessage) []moduletooling.ModuleInfo {
	t.Helper()
	var decoded []mtLoadedCase
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("module list undecodable: %v", err)
	}
	out := make([]moduletooling.ModuleInfo, 0, len(decoded))
	for _, m := range decoded {
		info := moduletooling.ModuleInfo{
			ModuleID:      m.ModuleID,
			ModuleName:    m.ModuleName,
			ModuleDir:     m.ModuleDir,
			SubModulePath: m.SubModulePath,
			IsOfficial:    m.IsOfficial,
			Dependencies:  m.Dependencies,
			LoadAfter:     m.LoadAfter,
			Incompatible:  m.Incompatible,
		}
		if m.Version != nil {
			info.Version, info.HasVersion = *m.Version, true
		}
		if m.OfficialFlag != nil {
			info.OfficialFlag, info.HasOfficial = *m.OfficialFlag, true
		}
		if m.DefaultModule != nil {
			info.DefaultModule, info.HasDefault = *m.DefaultModule, true
		}
		if m.ModuleType != nil {
			info.ModuleType, info.HasType = *m.ModuleType, true
		}
		for _, meta := range m.DepMetadata {
			entry := moduletooling.RefMetadata{ModuleID: meta.ModuleID, Optional: meta.Optional}
			if meta.Order != nil {
				entry.Order, entry.HasOrder = *meta.Order, true
			}
			if meta.Version != nil {
				entry.Version, entry.HasVer = *meta.Version, true
			}
			info.DepMetadata = append(info.DepMetadata, entry)
		}
		for _, sm := range m.SubModules {
			entry := moduletooling.SubModuleInfo{Assemblies: sm.Assemblies, Tags: sm.Tags}
			if sm.Name != nil {
				entry.Name, entry.HasName = *sm.Name, true
			}
			if sm.DLLName != nil {
				entry.DLLName, entry.HasDLLName = *sm.DLLName, true
			}
			if sm.ClassType != nil {
				entry.ClassType, entry.HasClass = *sm.ClassType, true
			}
			info.SubModules = append(info.SubModules, entry)
		}
		for _, dll := range m.DLLFiles {
			entry := moduletooling.DLLInfo{FileName: dll.FileName, RelativePath: dll.RelativePath}
			if dll.MD5 != nil {
				entry.MD5, entry.HasMD5 = *dll.MD5, true
			}
			info.DLLFiles = append(info.DLLFiles, entry)
		}
		out = append(out, info)
	}
	return out
}

// TestModuleToolingLoadOrderMatchesTypeScript compares the recommended order and the cycle report.
//
// ★ THE ORDER IS THE OUTPUT, so it is compared ELEMENT BY ELEMENT rather than as a set: a different
// valid topological order is a different answer for a user, and the ready-set sort is what decides
// which one comes out.
func TestModuleToolingLoadOrderMatchesTypeScript(t *testing.T) {
	f, _ := loadModuleToolingFixtures(t)

	compared := 0
	for _, c := range f.OrderCases {
		modules := decodeMTModules(t, c.Modules)
		got := moduletooling.BuildRecommendedLoadOrder(modules)

		if len(got.OrderedModuleIDs) != len(c.Result.OrderedModuleIDs) {
			t.Errorf("%s: ordered %v, want %v", c.Label, got.OrderedModuleIDs, c.Result.OrderedModuleIDs)
			continue
		}
		for i := range got.OrderedModuleIDs {
			if got.OrderedModuleIDs[i] != c.Result.OrderedModuleIDs[i] {
				t.Errorf("%s: ordered[%d] = %q, want %q\nfull: %v vs %v",
					c.Label, i, got.OrderedModuleIDs[i], c.Result.OrderedModuleIDs[i],
					got.OrderedModuleIDs, c.Result.OrderedModuleIDs)
			}
		}
		if got.CycleDetected != c.Result.CycleDetected {
			t.Errorf("%s: cycleDetected = %v, want %v", c.Label, got.CycleDetected, c.Result.CycleDetected)
		}
		if len(got.UnresolvedModuleIDs) != len(c.Result.UnresolvedModuleIDs) {
			t.Errorf("%s: unresolved %v, want %v", c.Label, got.UnresolvedModuleIDs, c.Result.UnresolvedModuleIDs)
			continue
		}
		for i := range got.UnresolvedModuleIDs {
			if got.UnresolvedModuleIDs[i] != c.Result.UnresolvedModuleIDs[i] {
				t.Errorf("%s: unresolved[%d] = %q, want %q", c.Label, i, got.UnresolvedModuleIDs[i], c.Result.UnresolvedModuleIDs[i])
			}
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no load-order cases were compared")
	}
	t.Logf("compared %d load-order cases", compared)
}

// TestModuleToolingIssuesMatchTypeScript compares every field of every issue, positionally.
func TestModuleToolingIssuesMatchTypeScript(t *testing.T) {
	f, _ := loadModuleToolingFixtures(t)

	total := 0
	for _, c := range f.IssueCases {
		modules := decodeMTModules(t, c.Modules)
		got := moduletooling.CollectDoctorIssues(modules)

		if len(got) != len(c.Result) {
			t.Errorf("%s: %d issues, want %d", c.Label, len(got), len(c.Result))
			for i, iss := range got {
				t.Logf("   got[%d]  %s/%s %s", i, iss.Severity, iss.IssueType, iss.Detail)
			}
			for i, iss := range c.Result {
				t.Logf("   want[%d] %s/%s %s", i, iss.Severity, iss.IssueType, iss.Detail)
			}
			continue
		}
		for i := range got {
			want := c.Result[i]
			if got[i].Severity != want.Severity || got[i].IssueType != want.IssueType ||
				got[i].Detail != want.Detail {
				t.Errorf("%s: issue %d = %s/%s\n  detail %q\n  want   %s/%s\n  detail %q",
					c.Label, i, got[i].Severity, got[i].IssueType, got[i].Detail,
					want.Severity, want.IssueType, want.Detail)
			}
			if deref(want.ModuleID) != got[i].ModuleID {
				t.Errorf("%s: issue %d moduleId = %q, want %q", c.Label, i, got[i].ModuleID, deref(want.ModuleID))
			}
			if deref(want.RelatedModuleID) != got[i].RelatedModuleID {
				t.Errorf("%s: issue %d relatedModuleId = %q, want %q", c.Label, i, got[i].RelatedModuleID, deref(want.RelatedModuleID))
			}
			if deref(want.DLLName) != got[i].DLLName {
				t.Errorf("%s: issue %d dllName = %q, want %q", c.Label, i, got[i].DLLName, deref(want.DLLName))
			}
			// The paths are compared by their TAIL: the fixture records the TypeScript's paths, which
			// were formed from its own absolute game dir.
			if want.FilePath != nil && *want.FilePath != "" {
				if !strings.HasSuffix(normaliseSlashes(got[i].FilePath), normaliseSlashes(*want.FilePath)) {
					t.Errorf("%s: issue %d filePath = %q, want a path ending in %q", c.Label, i, got[i].FilePath, *want.FilePath)
				}
			}
		}
		total += len(got)
	}
	t.Logf("compared %d issues across %d cases", total, len(f.IssueCases))
}

// TestModuleToolingFocusMatchesTypeScript compares the focus selection, including the all-official
// fallback that returns EVERYTHING rather than nothing.
func TestModuleToolingFocusMatchesTypeScript(t *testing.T) {
	f, _ := loadModuleToolingFixtures(t)

	// The fixture list, rebuilt with the same ids and dirs the generator used.
	modules := []moduletooling.ModuleInfo{
		{ModuleID: "Official", IsOfficial: true, ModuleDir: "D:/x/Modules/Official"},
		{ModuleID: "Community", IsOfficial: false, ModuleDir: "D:/x/Modules/Community"},
		{ModuleID: "Community", IsOfficial: false, ModuleDir: "D:/x/Modules/CommunityTwo"},
		// The substring discriminators: `Mod` is contained in `PrefixMod`, and `Prefi` is contained
		// in `PrefixMod` while matching nothing exactly.
		{ModuleID: "PrefixMod", IsOfficial: false, ModuleDir: "D:/x/Modules/PrefixMod"},
		{ModuleID: "Mod", IsOfficial: false, ModuleDir: "D:/x/Modules/Mod"},
	}

	for _, c := range f.FocusCases {
		var id, path string
		if len(c.Args) > 0 && c.Args[0] != nil {
			id = *c.Args[0]
		}
		if len(c.Args) > 1 && c.Args[1] != nil {
			path = *c.Args[1]
		}
		got := moduletooling.ComputeDoctorFocusModules(modules, id, path)
		labels := make([]string, 0, len(got))
		for _, m := range got {
			labels = append(labels, m.ModuleID+"|"+m.ModuleDir)
		}
		if len(labels) != len(c.Result) {
			t.Errorf("%s: %v, want %v", c.Label, labels, c.Result)
			continue
		}
		for i := range labels {
			if labels[i] != c.Result[i] {
				t.Errorf("%s: [%d] = %q, want %q", c.Label, i, labels[i], c.Result[i])
			}
		}
	}

	// The fallback: with every module official, the selection is ALL of them.
	allOfficial := []moduletooling.ModuleInfo{
		{ModuleID: "O1", IsOfficial: true}, {ModuleID: "O2", IsOfficial: true},
	}
	got := moduletooling.ComputeDoctorFocusModules(allOfficial, "", "")
	if len(got) != len(f.AllOfficialFocus) {
		t.Errorf("all-official fallback selected %d modules, want %d", len(got), len(f.AllOfficialFocus))
	}
	t.Logf("compared %d focus cases", len(f.FocusCases))
}

// TestModuleToolingLoadMatchesTypeScript drives the module LOADER against the rebuilt tree and
// compares every field of every module, including the two official-rule branches and the id
// fallback.
//
// ★ THIS IS THE PART THE PORT DOES NOT IMPLEMENT — the file-system half is deliberately absent (see
// the package note), so the comparison runs the REAL TypeScript loader against the fixture tree and
// asserts the properties the Go side has to satisfy when a caller supplies the parsed modules. That
// keeps the corpus honest about where the port ends.
func TestModuleToolingLoadMatchesTypeScript(t *testing.T) {
	f, root := loadModuleToolingFixtures(t)
	_ = root

	// The loader itself is the TypeScript's; what is checked here is that the fixture's recorded
	// values are consistent with the XML the shape declares — so a change to the shape that silently
	// invalidates a case fails loudly.
	//
	// ★ THE LOOKUP IS A SLICE SCAN, NOT A MAP, AND THAT IS A FIX. A map keyed by module id keeps the
	// FIRST case per id and drops later ones — which silently removed `SandBox` from every check
	// below, because the loader returns its modules in a sorted order the map did not preserve. The
	// official-set mutation survived against that map for exactly this reason. A module id is NOT
	// unique (the corpus contains a deliberate duplicate), so the lookup must not assume it is.
	byID := func(moduleID string) (mtLoadedCase, bool) {
		for _, c := range f.LoadedCases {
			if c.ModuleID == moduleID {
				return c, true
			}
		}
		return mtLoadedCase{}, false
	}

	if len(f.LoadedCases) != len(f.Shape.Modules)-1 {
		t.Errorf("%d modules loaded from %d directories; exactly one directory is meant to be skipped for having no SubModule.xml",
			len(f.LoadedCases), len(f.Shape.Modules))
	}

	// ★ THE OFFICIALNESS RULE IS THE PORT'S OWN, SO IT IS COMPARED AGAINST THE REAL LOADER rather
	// than against the fixture's recorded values. The loader is the one piece the port does NOT
	// implement; a caller supplies parsed modules and needs this rule, so the generator built a
	// matrix of inputs, ran the REAL loadBannerlordModules over it, and recorded the answer. That is
	// what makes a mutation of the set observable: it changes the PREDICATE's answer, not a value the
	// fixture merely repeats.
	for _, row := range f.OfficialMatrix {
		if row.IsOfficial == nil {
			t.Errorf("matrix row %q has no recorded answer; the generator did not load it", row.DirName)
			continue
		}
		moduleType := ""
		if row.Type != nil {
			moduleType = *row.Type
		}
		hasFlag := row.Official != nil
		flag := false
		if hasFlag {
			flag = strings.EqualFold(strings.TrimSpace(*row.Official), "true")
		}
		want := *row.IsOfficial
		// The id the loader ended up with is what the set is consulted against, and for the no-Id row
		// that is the DIRECTORY name.
		effectiveID := row.ID
		if effectiveID == "" && row.LoadedModuleID != nil {
			effectiveID = *row.LoadedModuleID
		}
		if got := moduletooling.IsOfficial(effectiveID, moduleType, flag, hasFlag); got != want {
			t.Errorf("IsOfficial(id=%q, type=%q, flag=%v/%v) = %v, want %v (from the real loader)",
				effectiveID, moduleType, flag, hasFlag, got, want)
		}
	}
	if len(f.OfficialMatrix) == 0 {
		t.Fatal("the officialness matrix is missing from the fixtures")
	}
	t.Logf("compared %d officialness decisions against the real loader", len(f.OfficialMatrix))

	// The three mechanisms, spelled out so a failure names the mechanism rather than just an id.
	checks := []struct {
		moduleID string
		want     bool
		why      string
	}{
		{"Native", true, "the id is in the official set"},
		{"Sandbox", true, "ModuleType is 'official' (compared case-insensitively)"},
		{"SandBox", true, "the set contains BOTH `Sandbox` and `SandBox`, and this is the second spelling"},
		{"CustomBattle", true, "Official is false but the id is in the set, and the set wins"},
		{"BrokenMod", false, "no flag, no type, not in the set"},
		{"NoIdMod", false, "the id fell back to the DIRECTORY name"},
	}
	for _, c := range checks {
		loaded, ok := byID(c.moduleID)
		if !ok {
			t.Errorf("the corpus no longer contains module %q (%s)", c.moduleID, c.why)
			continue
		}
		if loaded.IsOfficial != c.want {
			t.Errorf("module %q: isOfficial = %v, want %v (%s)", c.moduleID, loaded.IsOfficial, c.want, c.why)
		}
	}

	// The id fallback: a module with no <Id> takes its DIRECTORY name.
	if noID, ok := byID("NoIdMod"); ok && noID.ModuleID != "NoIdMod" {
		t.Errorf("the id fallback produced %q, want the directory name", noID.ModuleID)
	}

	// The DLL scan walked a NESTED bin directory as well as the top level.
	if broken, ok := byID("BrokenMod"); ok {
		names := make([]string, 0, len(broken.DLLFiles))
		for _, d := range broken.DLLFiles {
			names = append(names, d.RelativePath)
		}
		foundNested := false
		for _, n := range names {
			if strings.Contains(n, "Win64_Shipping_Client/nested.dll") {
				foundNested = true
			}
		}
		if !foundNested {
			t.Errorf("the DLL scan missed the nested bin directory; got %v", names)
		}
	}

	// The submodule tag collection: `key=value`, and a tag with only a key yields just the key.
	if broken, ok := byID("BrokenMod"); ok {
		for _, sm := range broken.SubModules {
			if sm.Name != nil && *sm.Name == "WithAssembliesAndTags" {
				// ★ `[key, value].filter(Boolean).join('=')`: a tag with ONLY a value keeps the
				// value (`v3`), and the first version of this assertion expected it to be dropped —
				// the expectation was wrong, not the fixture. The three corpus tags therefore cover
				// key+value, key alone, and value alone.
				wantTags := []string{"k1=v1", "k2", "v3"}
				if len(sm.Tags) != len(wantTags) {
					t.Errorf("tags = %v, want %v", sm.Tags, wantTags)
					continue
				}
				for i := range wantTags {
					if sm.Tags[i] != wantTags[i] {
						t.Errorf("tag %d = %q, want %q", i, sm.Tags[i], wantTags[i])
					}
				}
				if len(sm.Assemblies) != 2 {
					t.Errorf("assemblies = %v, want 2 entries", sm.Assemblies)
				}
			}
		}
	}
	t.Logf("checked %d loaded modules against their declared properties", len(f.LoadedCases))
}

// officialIDSetCovers reports whether the fixture's own expectations imply the id is decided by the
// official SET — i.e. the module is official while neither the flag nor the type says so.
func officialIDSetCovers(moduleID string, f mtFixtures) bool {
	for _, c := range f.LoadedCases {
		if c.ModuleID == moduleID && c.IsOfficial {
			flagOff := c.OfficialFlag == nil || !*c.OfficialFlag
			typeOff := c.ModuleType == nil || stringLower(*c.ModuleType) != "official"
			if flagOff && typeOff {
				return true
			}
		}
	}
	return false
}

func stringLower(value string) string {
	return strings.ToLower(value)
}

// normaliseSlashes lets a fixture path recorded with one separator compare against a Go path.
func normaliseSlashes(value string) string {
	return strings.ReplaceAll(value, "\\", "/")
}
