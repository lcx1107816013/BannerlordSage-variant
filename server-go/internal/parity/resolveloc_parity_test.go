package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blore/internal/tools"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// resolve_localization parity (src/tools/resolve-localization.ts)
//
// The tool is a SHAPING layer: it parses the token itself, asks
// localization.ResolveLocalizationDetails for the rows, then formats everything into an
// ai-text report. The fixtures capture that rendered TEXT, because the text is what a client
// parses and a byte difference is a real difference.
//
// The corpus deliberately contains the inputs that made a real defect visible. Every
// pre-existing token fixture in this suite was SINGLE-LINE, so the Go token scanner and the
// TypeScript regex agreed on all of them while disagreeing on inputs nobody had written down:
//
//	{=id}text\nmore   the TS regex refuses it (`.` excludes a line terminator, `$` anchors the
//	                  end), while a scanner that just looks for the first `}` accepts it.
//
// Those cases are the reason this suite exists in this shape. If they were ever removed, the
// defect could come back with every test still green — which is the failure mode this project
// keeps finding (F11/F12/F18/F21/F24/F25).
// ─────────────────────────────────────────────────────────────────────────────

type rlCase struct {
	Text      string   `json:"text"`
	Languages []string `json:"languages"`
	Label     string   `json:"label"`
	OK        bool     `json:"ok"`
	Output    string   `json:"output"`
	Error     string   `json:"error"`
}

type rlFixtures struct {
	DBPath string   `json:"dbPath"`
	Cases  []rlCase `json:"cases"`
}

func loadResolveLocalizationFixtures(t *testing.T) (rlFixtures, *sql.DB) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "resolveloc_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_resolvelocalization_fixtures.mjs", path, err)
	}
	var f rlFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatalf("fixtures look empty; refusing to report success")
	}

	dbFile := filepath.Join("..", "..", f.DBPath)
	if _, err := os.Stat(dbFile); err != nil {
		t.Fatalf("fixture database missing (%s): %v\nregenerate the fixtures", dbFile, err)
	}
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatalf("cannot open fixture database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return f, db
}

// TestResolveLocalizationMatchesTypeScript compares the rendered report text, byte for byte,
// against what the real TypeScript produced against the same committed database.
func TestResolveLocalizationMatchesTypeScript(t *testing.T) {
	f, db := loadResolveLocalizationFixtures(t)

	compared := 0
	earlyReturns := 0
	reports := 0

	for _, c := range f.Cases {
		got, err := tools.ResolveLocalization(db, c.Text, c.Languages)
		if err != nil {
			t.Errorf("ResolveLocalization(%q, %v) errored: %v", c.Text, c.Languages, err)
			continue
		}
		if !c.OK {
			// The TypeScript threw where we return an error. There is no such case in the
			// corpus today, and a new one would need a decision rather than a silent pass.
			t.Errorf("fixture %q (%s) recorded a THROW (%s) but the port returned a value",
				c.Label, c.Text, c.Error)
			continue
		}
		if got != c.Output {
			t.Errorf("ResolveLocalization(%q, %v) [%s] differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				c.Text, c.Languages, c.Label, got, c.Output, textFirstDiff(got, c.Output))
		}
		if strings.HasPrefix(got, "report_type: ") {
			reports++
		} else {
			earlyReturns++
		}
		compared++
	}

	if compared == 0 {
		t.Fatal("no resolve_localization cases were compared")
	}
	// Both branches must actually be exercised, or the suite is measuring one of them and
	// reporting on both.
	if earlyReturns == 0 || reports == 0 {
		t.Fatalf("corpus does not exercise both branches (early=%d reports=%d); "+
			"a suite that only covers one cannot vouch for the other", earlyReturns, reports)
	}
	t.Logf("compared %d resolve_localization reports against the TypeScript (%d early returns, %d reports)",
		compared, earlyReturns, reports)
}

// TestResolveLocalizationLineTerminatorInTail pins the defect directly, independent of the
// corpus: with a line terminator anywhere in the tail the TypeScript refuses the token, so the
// tool must return the not-a-token sentence rather than a report. These five inputs are the
// measured divergence; a Go scanner that ignores them fails here.
func TestResolveLocalizationLineTerminatorInTail(t *testing.T) {
	_, db := loadResolveLocalizationFixtures(t)

	refused := []string{
		"{=rl_spread}Spread\nSecond line",
		"{=rl_spread}Spread\r\nSecond line",
		"{=rl_spread}Spread\n",
		"{=rl_spread}Spread\r",
		"{=rl_spread}Spread\u2028x",
		"{=rl_spread}Spread\u2029",
	}
	for _, input := range refused {
		got, err := tools.ResolveLocalization(db, input, nil)
		if err != nil {
			t.Errorf("ResolveLocalization(%q) errored: %v", input, err)
			continue
		}
		if got != notATokenMessage {
			t.Errorf("line terminator in the tail was ACCEPTED for %q\n got: %s", input, firstLine(got))
		}
	}

	// The complement: these are NOT line terminators in ECMAScript, so the token still parses
	// and the result is a report. Without this half, a port that simply rejected every control
	// character would pass.
	accepted := []string{
		"{=rl_spread}Spread\u000b", // vertical tab
		"{=rl_spread}Spread\u0085", // NEL
	}
	for _, input := range accepted {
		got, err := tools.ResolveLocalization(db, input, nil)
		if err != nil {
			t.Errorf("ResolveLocalization(%q) errored: %v", input, err)
			continue
		}
		if !strings.HasPrefix(got, "report_type: ") {
			t.Errorf("a non-terminator control character REJECTED the token for %q\n got: %s", input, firstLine(got))
		}
	}
}

// TestResolveLocalizationOmittedBranch asserts the >10 source-entry branch through the
// rendered text: the count is the FULL length, the list stops at ten, and the omitted count is
// the difference - three numbers that a plausible port can get individually wrong.
func TestResolveLocalizationOmittedBranch(t *testing.T) {
	f, db := loadResolveLocalizationFixtures(t)

	var probe *rlCase
	for i := range f.Cases {
		if strings.Contains(f.Cases[i].Label, "omitted branch") {
			probe = &f.Cases[i]
			break
		}
	}
	if probe == nil {
		t.Fatal("the corpus no longer contains the omitted-branch case; the >10 path is untested")
	}

	got, err := tools.ResolveLocalization(db, probe.Text, probe.Languages)
	if err != nil {
		t.Fatalf("ResolveLocalization(%q) errored: %v", probe.Text, err)
	}
	if !strings.Contains(got, "source_entries_omitted: ") {
		t.Fatalf("the omitted field is absent:\n%s", got)
	}
	// The rendered list must stop at ten items.
	items := strings.Count(got, "\n- fallback_text=")
	if items != 10 {
		t.Errorf("rendered source entries = %d, want 10", items)
	}
}

// notATokenMessage is the literal sentence the tool returns when the input does not parse.
// Duplicated here on purpose: it is the contract, and a test that imported it from the
// implementation could not notice the wording changing.
const notATokenMessage = "Input text is not a Bannerlord localization token. Expected format: {=str_id}Fallback Text"

func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}
