package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/gameprofiles"
)

// ─────────────────────────────────────────────────────────────────────────────
// game-profiles parity (src/utils/game-profiles.ts)
//
// The module-private helpers were extracted VERBATIM from the source by the generator and executed,
// so these expectations are the real function's output. The corpus pins what a careful reader would
// "fix":
//
//   - a module is official by the ALLOWLIST ONLY. `ModuleType=Official` and `Official=true` are
//     recorded (metadataSuggestsOfficial) and then IGNORED for the decision — ClaimedOfficial is
//     false and RenamedDir is true
//   - the reason string carries the moduleType verbatim, spaces and case included
//   - `Official` distinguishes ABSENT (nil) from present-but-garbage (false)
//   - the modding-support DLLs are accepted BEFORE the official-prefix test, which is the only
//     reason Newtonsoft.Json.dll passes
//   - the root-bin denylist is checked before the prefix list
//   - getXmlValue matches inside a COMMENT and rejects value="" (one-or-more, not zero-or-more)
// ─────────────────────────────────────────────────────────────────────────────

type gpc struct {
	ModuleName               string  `json:"moduleName"`
	ModuleID                 string  `json:"moduleId"`
	ModuleType               *string `json:"moduleType"`
	OfficialFlag             *bool   `json:"officialFlag"`
	MetadataSuggestsOfficial bool    `json:"metadataSuggestsOfficial"`
	IsOfficial               bool    `json:"isOfficial"`
	Reason                   string  `json:"reason"`
	ModuleDir                string  `json:"moduleDir"`
}

type gpXMLValueCase struct {
	Raw    string  `json:"raw"`
	Tag    string  `json:"tag"`
	Result *string `json:"result"`
}

type gpPathCase struct {
	Path   string `json:"path"`
	Result bool   `json:"result"`
}

type gpScoreCase struct {
	Path   string `json:"path"`
	Result int    `json:"result"`
}

type gpFixtures struct {
	ModulesRoot     string           `json:"modulesRoot"`
	Classifications []gpc            `json:"classifications"`
	XMLValueCases   []gpXMLValueCase `json:"xmlValueCases"`
	OfficialBin     []gpPathCase     `json:"officialBinCases"`
	ModdingBin      []gpPathCase     `json:"moddingBinCases"`
	ScoreCases      []gpScoreCase    `json:"scoreCases"`
}

func loadGameProfileFixtures(t *testing.T) gpFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "gameprofiles_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_gameprofiles_fixtures.mjs", path, err)
	}
	var f gpFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Classifications) == 0 || len(f.XMLValueCases) == 0 ||
		len(f.OfficialBin) == 0 || len(f.ModdingBin) == 0 || len(f.ScoreCases) == 0 {
		t.Fatalf("fixtures look incomplete (%d/%d/%d/%d/%d); refusing to report success",
			len(f.Classifications), len(f.XMLValueCases), len(f.OfficialBin), len(f.ModdingBin), len(f.ScoreCases))
	}
	// The module corpus must exist: the classification cases are keyed to a real directory.
	root := filepath.Join("..", "..", "tools", "parity", "fixtures", "gameprofiles", "Modules")
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("the module corpus is missing (%s): %v", root, err)
	}
	return f
}

func TestGameProfileXMLValueMatchesTypeScript(t *testing.T) {
	f := loadGameProfileFixtures(t)

	for _, c := range f.XMLValueCases {
		got := gameprofiles.GetXMLValue(c.Raw, c.Tag)
		if !sameStringPtr(got, c.Result) {
			t.Errorf("GetXMLValue(%q, %q)\n  go = %s\n  ts = %s",
				c.Raw, c.Tag, renderStringPtr(got), renderStringPtr(c.Result))
		}
	}
	t.Logf("compared %d getXmlValue cases", len(f.XMLValueCases))
}

func TestGameProfileBinPredicatesMatchTypeScript(t *testing.T) {
	f := loadGameProfileFixtures(t)

	for _, c := range f.OfficialBin {
		if got := gameprofiles.IsOfficialRootBinDLL(c.Path); got != c.Result {
			t.Errorf("IsOfficialRootBinDLL(%q) = %v, want %v", c.Path, got, c.Result)
		}
	}
	for _, c := range f.ModdingBin {
		if got := gameprofiles.IsModdingRootBinDLL(c.Path); got != c.Result {
			t.Errorf("IsModdingRootBinDLL(%q) = %v, want %v", c.Path, got, c.Result)
		}
	}
	t.Logf("compared %d official + %d modding DLL predicates", len(f.OfficialBin), len(f.ModdingBin))
}

func TestGameProfileScoreMatchesTypeScript(t *testing.T) {
	f := loadGameProfileFixtures(t)

	for _, c := range f.ScoreCases {
		if got := gameprofiles.ScoreDLLPath(c.Path); got != c.Result {
			t.Errorf("ScoreDLLPath(%q) = %d, want %d", c.Path, got, c.Result)
		}
	}
	t.Logf("compared %d scoreDLLPath cases", len(f.ScoreCases))
}

// TestGameProfileClassificationMatchesTypeScript replays the recorded classifications.
//
// The corpus is a DIRECTORY, and the real classifier reads it (including each module's
// SubModule.xml). This test re-reads the same directory, so the input is the committed tree rather
// than a copy of it — the Fixture Discipline this project applies to every suite.
func TestGameProfileClassificationMatchesTypeScript(t *testing.T) {
	f := loadGameProfileFixtures(t)
	root := filepath.Join("..", "..", "tools", "parity", "fixtures", "gameprofiles", "Modules")

	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("cannot read the module corpus: %v", err)
	}
	if len(entries) != len(f.Classifications) {
		t.Fatalf("the corpus has %d directories but the fixtures describe %d; regenerate",
			len(entries), len(f.Classifications))
	}

	for _, want := range f.Classifications {
		dir := filepath.Join(root, want.ModuleName)
		subModulePath := filepath.Join(dir, "SubModule.xml")
		subModuleXML := ""
		if raw, err := os.ReadFile(subModulePath); err == nil {
			subModuleXML = string(raw)
		}

		// The declared Id comes from the XML; the classifier falls back to the directory name.
		var moduleID string
		if id := gameprofiles.GetXMLValue(subModuleXML, "Id"); id != nil {
			moduleID = *id
		}

		got := gameprofiles.ClassifyModule(want.ModuleName, moduleID, subModuleXML, dir)

		if got.ModuleName != want.ModuleName || got.ModuleID != want.ModuleID ||
			got.IsOfficial != want.IsOfficial || got.MetadataSuggestsOfficial != want.MetadataSuggestsOfficial ||
			got.Reason != want.Reason {
			t.Errorf("ClassifyModule(%q)\n  go = name=%q id=%q official=%v meta=%v reason=%q\n  ts = name=%q id=%q official=%v meta=%v reason=%q",
				want.ModuleName,
				got.ModuleName, got.ModuleID, got.IsOfficial, got.MetadataSuggestsOfficial, got.Reason,
				want.ModuleName, want.ModuleID, want.IsOfficial, want.MetadataSuggestsOfficial, want.Reason)
		}
		if !sameBoolPtr(got.OfficialFlag, want.OfficialFlag) {
			t.Errorf("ClassifyModule(%q).OfficialFlag = %s, want %s",
				want.ModuleName, renderBoolPtr(got.OfficialFlag), renderBoolPtr(want.OfficialFlag))
		}
		if !sameStringPtr(nilIfEmpty(got.ModuleType), want.ModuleType) {
			t.Errorf("ClassifyModule(%q).ModuleType = %s, want %s",
				want.ModuleName, renderStringPtr(nilIfEmpty(got.ModuleType)), renderStringPtr(want.ModuleType))
		}
	}
	t.Logf("compared %d module classifications against the TypeScript", len(f.Classifications))
}

// TestGameProfileOfficialDecisionIsTheAllowlist pins the asymmetry directly: metadata claiming
// official does NOT make a module official, and a directory named something else whose Id is
// allowlisted DOES. A port that "fixed" this to trust the metadata would fail here.
func TestGameProfileOfficialDecisionIsTheAllowlist(t *testing.T) {
	// Metadata says Official; the allowlist does not list it.
	claimed := gameprofiles.ClassifyModule("ClaimedOfficial", "ClaimedOfficial",
		`<Module><Id value="ClaimedOfficial" /><ModuleType value="Official" /></Module>`, "dir")
	if claimed.IsOfficial {
		t.Error("a module with ModuleType=Official was treated as official; the TS decides by allowlist")
	}
	if !claimed.MetadataSuggestsOfficial {
		t.Error("MetadataSuggestsOfficial should be true: the metadata does claim official")
	}
	if claimed.Reason != "metadata-only:Official" {
		t.Errorf("reason = %q, want the metadata-only form", claimed.Reason)
	}

	// The directory is not allowlisted, but the declared Id is.
	renamed := gameprofiles.ClassifyModule("RenamedDir", "Native", `<Module><Id value="Native" /></Module>`, "dir")
	if !renamed.IsOfficial {
		t.Error("a module whose declared Id is allowlisted must be official even if the directory is not")
	}
	if renamed.Reason != "official-allowlist" {
		t.Errorf("reason = %q, want official-allowlist", renamed.Reason)
	}
}

// TestGameProfileCollectXMLFiles pins the scope decision, which the TypeScript expresses as two
// filters over the same list.
func TestGameProfileCollectXMLFiles(t *testing.T) {
	items := []gameprofiles.XmlModuleClassification{
		{ModuleName: "Native", IsOfficial: true},
		{ModuleName: "Mod", IsOfficial: false},
	}

	included, skipped := gameprofiles.CollectXMLFiles(items, "official")
	if len(included) != 1 || included[0].ModuleName != "Native" {
		t.Errorf("official scope included %v, want just Native", names(included))
	}
	if len(skipped) != 1 || skipped[0].ModuleName != "Mod" {
		t.Errorf("official scope skipped %v, want just Mod", names(skipped))
	}

	includedAll, skippedAll := gameprofiles.CollectXMLFiles(items, "all")
	if len(includedAll) != 2 {
		t.Errorf("all scope included %v, want both", names(includedAll))
	}
	if len(skippedAll) != 0 {
		t.Errorf("all scope skipped %v, want none", names(skippedAll))
	}
}

// ── small helpers ────────────────────────────────────────────────────────────

func names(items []gameprofiles.XmlModuleClassification) []string {
	out := make([]string, 0, len(items))
	for _, i := range items {
		out = append(out, i.ModuleName)
	}
	return out
}

func sameStringPtr(a, b *string) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func sameBoolPtr(a, b *bool) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return *a == *b
}

func renderStringPtr(s *string) string {
	if s == nil {
		return "<nil>"
	}
	return "\"" + *s + "\""
}

func renderBoolPtr(b *bool) string {
	if b == nil {
		return "<nil>"
	}
	if *b {
		return "true"
	}
	return "false"
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
