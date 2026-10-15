package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"blore/internal/env"
)

// ─────────────────────────────────────────────────────────────────────────────
// env parity (src/utils/env.ts)
//
// Expected values come from tools/parity/env_fixtures.json, produced by IMPORTING
// the TypeScript module (not by extracting functions — getGamePaths closes over a
// module-level constant, so pulling it out would change its behaviour).
//
// ROOT DIVERGENCE, stated up front: the TypeScript derives the repo root from its own
// source location; the Go port is a standalone binary with no source, so it resolves
// root from BLORE_ROOT or by walking up for a repo marker. The fixture records the
// TypeScript's root so this test can require the SAME root on the Go side via
// BLORE_ROOT. Without that precondition the paths are not comparable, and comparing
// them anyway would produce a permanent false failure — so the test asserts the
// precondition instead of skipping quietly.
// ─────────────────────────────────────────────────────────────────────────────

type envNormalizeCase struct {
	Tag    string `json:"tag"`
	Value  any    `json:"value"`
	OK     bool   `json:"ok"`
	Result string `json:"result"`
	Error  string `json:"error"`
}

type envPathsCase struct {
	Input string            `json:"input"`
	Keys  []string          `json:"keys"`
	Paths map[string]string `json:"paths"`
}

type envFixtures struct {
	TSRoot        string             `json:"tsRoot"`
	DefaultGameID string             `json:"defaultGameId"`
	Normalize     []envNormalizeCase `json:"normalize"`
	Paths         []envPathsCase     `json:"paths"`
}

func loadEnvFixtures(t *testing.T) envFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "env_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_env_fixtures.mjs", path, err)
	}
	var f envFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Normalize) == 0 || len(f.Paths) == 0 {
		t.Fatalf("fixtures look empty (normalize=%d paths=%d); refusing to report success",
			len(f.Normalize), len(f.Paths))
	}
	if f.TSRoot == "" {
		t.Fatal("fixtures do not record the TypeScript root; paths are not comparable")
	}
	return f
}

// whitespaceDivergenceFixes are the cases the port FIXED. strings.TrimSpace trims a
// different set from JS trim(), in both directions:
//
//	U+FEFF BOM : JS trims it, Go TrimSpace does not
//	U+0085 NEL : Go TrimSpace trims it, JS does not
//
// Any case containing U+FEFF must now match the TypeScript. Listed explicitly so the
// fix is asserted rather than merely described.
func containsBOM(s string) bool { return strings.ContainsRune(s, '\ufeff') }

// caseFoldingDivergence maps inputs where the port DECLARES a divergence instead of
// reproducing it. JavaScript's toLowerCase() applies the Unicode SpecialCasing table;
// Go's strings.ToLower applies only simple mapping. Marked expected-divergent here so
// the suite stays meaningful: an unexpected mismatch is a failure, and a declared one
// is a documented, bounded exception with a reason.
//
// Each entry names what the TypeScript produces, so if upstream's behaviour ever
// changes the entry stops matching and the test says so.
var caseFoldingDivergence = map[string]string{
	"İSTANBUL": "i\u0307stanbul", // U+0130 -> i + U+0307 (combining dot above)
	"ΣΊΣΥΦΟΣ":  "σίσυφος",        // final sigma U+03C2
}

func TestNormalizeGameIdMatchesTypeScript(t *testing.T) {
	f := loadEnvFixtures(t)
	compared := 0
	declared := 0
	for _, c := range f.Normalize {
		if !c.OK {
			t.Logf("skipping (TypeScript threw): tag=%s error=%s", c.Tag, c.Error)
			continue
		}
		// JSON cannot carry undefined; the tag decides whether a value is passed.
		if c.Tag != "undefined" && c.Value == nil {
			t.Fatalf("fixture tag=%s has no value; the port cannot be given the same input", c.Tag)
		}
		var input string
		if c.Tag != "undefined" {
			s, ok := c.Value.(string)
			if !ok {
				t.Fatalf("expected a string for tag=%s, got %T", c.Tag, c.Value)
			}
			input = s
		}

		got := env.NormalizeGameID(input)
		if got == c.Result {
			compared++
			continue
		}

		// Declared divergence: only valid if the fixture still shows the TypeScript
		// behaviour this entry was written for. A silent upstream change must fail.
		if want, isDeclared := caseFoldingDivergence[input]; isDeclared {
			if c.Result != want {
				t.Errorf("declared case-folding divergence for %q is out of date: "+
					"fixture now says ts=%q, the entry documents %q — re-verify and update",
					input, c.Result, want)
				continue
			}
			declared++
			t.Logf("declared divergence (case folding): %q  go=%q  ts=%q", input, got, c.Result)
			continue
		}

		hint := ""
		if containsBOM(input) {
			hint = "  (BOM: this one must now match — strings.TrimSpace would not trim U+FEFF)"
		}
		t.Errorf("normalizeGameId(%q)\n  go = %q\n  ts = %q%s", input, got, c.Result, hint)
		compared++
	}
	if compared == 0 {
		t.Fatal("no normalize cases were compared")
	}
	t.Logf("compared %d normalizeGameId cases against the TypeScript output (%d declared divergences)",
		compared, declared)
}

func TestGamePathsMatchTypeScript(t *testing.T) {
	f := loadEnvFixtures(t)

	// Precondition: the Go side must resolve the SAME root the TypeScript did, or the
	// comparison is meaningless. BLORE_ROOT is set here rather than in the environment
	// so the requirement is visible in the test itself.
	t.Setenv("BLORE_ROOT", f.TSRoot)
	if got := env.RootDir(); !samePath(got, f.TSRoot) {
		t.Fatalf("root precondition not met: go resolved %q, ts root is %q\n"+
			"set BLORE_ROOT so both sides compute paths from the same base", got, f.TSRoot)
	}

	compared := 0
	fieldMismatches := 0
	for _, c := range f.Paths {
		got := env.GetGamePaths(c.Input)

		// Field-set comparison FIRST. A port that silently drops a field would pass a
		// value-only check, which is how the missing xmlParseReportMarkdownPath stayed
		// invisible. This asserts the key sets match before comparing values.
		gotFields := envPathFields(got)
		if !sameStringSet(gotFields, c.Keys) {
			fieldMismatches++
			t.Errorf("getGamePaths(%q): field set differs\n  go = %v\n  ts = %v",
				c.Input, gotFields, c.Keys)
		}

		for _, key := range c.Keys {
			want, ok := c.Paths[key]
			if !ok {
				continue
			}
			gotValue, present := lookupEnvField(got, key)
			if !present {
				continue // already reported by the field-set check
			}
			if !samePath(gotValue, want) {
				t.Errorf("getGamePaths(%q).%s\n  go = %q\n  ts = %q", c.Input, key, gotValue, want)
			}
		}
		compared++
	}
	t.Logf("compared %d getGamePaths cases (%d fields each) against the TypeScript output",
		compared, len(f.Paths[0].Keys))
	if fieldMismatches > 0 {
		t.Logf("%d case(s) had a differing field set — see the field-set failures above", fieldMismatches)
	}
}

// envPathFields returns the TypeScript field names the Go struct actually carries.
// Kept as an explicit list rather than reflection, so adding a field to the port means
// consciously adding it here too — an omission cannot happen silently, which is how
// the two report paths stayed missing in the first place.
func envPathFields(p env.GamePaths) []string {
	fields := []string{
		"assetsPath", "csharpAstDumpPath", "dbPath", "defsPath", "gameDistPath",
		"gameId", "memoryDbPath", "reportsPath", "setupStatePath", "sourcePath",
		"versionPath", "xmlParseReportMarkdownPath", "xmlParseReportPath",
	}
	sort.Strings(fields)
	return fields
}

func lookupEnvField(p env.GamePaths, key string) (string, bool) {
	switch key {
	case "gameId":
		return p.GameID, true
	case "gameDistPath":
		return p.GameDistPath, true
	case "assetsPath":
		return p.AssetsPath, true
	case "reportsPath":
		return p.ReportsPath, true
	case "versionPath":
		return p.VersionPath, true
	case "defsPath":
		return p.DefsPath, true
	case "sourcePath":
		return p.SourcePath, true
	case "dbPath":
		return p.DBPath, true
	case "memoryDbPath":
		return p.MemoryDBPath, true
	case "setupStatePath":
		return p.SetupStatePath, true
	case "csharpAstDumpPath":
		return p.CSharpAstDumpPath, true
	case "xmlParseReportPath":
		return p.XMLParseReportPath, true
	case "xmlParseReportMarkdownPath":
		return p.XMLParseReportMarkdownPath, true
	default:
		return "", false
	}
}

// samePath compares paths the way the platforms do: case-insensitively on Windows,
// exactly elsewhere. Pure string equality would produce spurious failures on Windows
// where the same directory can be spelled with different case.
func samePath(a, b string) bool {
	if runtime.GOOS == "windows" {
		return strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
	}
	return filepath.Clean(a) == filepath.Clean(b)
}

func sameStringSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	as := append([]string(nil), a...)
	bs := append([]string(nil), b...)
	sort.Strings(as)
	sort.Strings(bs)
	for i := range as {
		if as[i] != bs[i] {
			return false
		}
	}
	return true
}
