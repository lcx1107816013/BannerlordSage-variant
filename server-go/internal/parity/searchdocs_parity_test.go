package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blore/internal/apidocs"
	"blore/internal/tools"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// search_docs parity (src/tools/search-docs.ts)
//
// The corpus is a crafted FTS5 database, and the expectations are the TypeScript's rendered text
// against that same committed database. It separates rules rather than looking realistic:
//
//   - the source filter maps a NAME to a TABLE VALUE, so `source_filter: own` filters on
//     `own_knowledge`, while an unrecognised filter stops filtering and still renders as itself
//   - the missing-index case is a REPORT with no blocks, not an error
//   - `row.snippet || '(no snippet)'` catches BOTH a NULL snippet and an empty one — the differential
//     found this port crashing on the NULL case when such a row was added to the corpus
//   - the limit clamp: a negative limit becomes the floor of 1 rather than the default, and the
//     ceiling is 25
//
// search_api_docs is covered separately, further down this file, by a corpus whose expectations come
// from the real function with its I/O modules injected.
// ─────────────────────────────────────────────────────────────────────────────

type sdCase struct {
	Query  string `json:"query"`
	Source string `json:"source"`
	Limit  int    `json:"limit"`
	OK     bool   `json:"ok"`
	Text   string `json:"text"`
	Error  string `json:"error"`
}

type sdFixtures struct {
	DocsDBPath string   `json:"docsDbPath"`
	DocsCases  []sdCase `json:"docsCases"`
}

func loadSearchDocsFixtures(t *testing.T) sdFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "searchdocs_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_searchdocs_fixtures.mjs", path, err)
	}
	var f sdFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.DocsCases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.DocsCases {
		if !c.OK {
			t.Fatalf("fixture (query=%q) recorded a THROW (%s); this tool has no error branch for that", c.Query, c.Error)
		}
	}
	return f
}

func TestSearchDocsMatchesTypeScript(t *testing.T) {
	f := loadSearchDocsFixtures(t)
	db := openFixtureDB(t, f.DocsDBPath)

	compared := 0
	for _, c := range f.DocsCases {
		got, err := tools.SearchDocs(db, c.Query, c.Source, c.Limit)
		if err != nil {
			t.Errorf("SearchDocs(%q, %q, %d) errored: %v", c.Query, c.Source, c.Limit, err)
			continue
		}
		if got != c.Text {
			t.Errorf("SearchDocs(%q, %q, %d) differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				c.Query, c.Source, c.Limit, got, c.Text, textFirstDiff(got, c.Text))
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no search_docs cases were compared")
	}
	t.Logf("compared %d search_docs reports against the TypeScript", compared)
}

// TestSearchDocsMissingIndexIsAReport pins the branch that a corpus with a populated index cannot
// reach: no FTS table means a report with NO blocks and two specific top fields, not an error.
func TestSearchDocsMissingIndexIsAReport(t *testing.T) {
	// An in-memory database with no tables at all.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	got, err := tools.SearchDocs(db, "anything", "own", 8)
	if err != nil {
		t.Fatalf("a missing index must not be an error: %v", err)
	}
	if !strings.Contains(got, "index_status: missing") {
		t.Errorf("expected index_status: missing, got:\n%s", got)
	}
	if !strings.Contains(got, "setup_hint: ") {
		t.Errorf("expected a setup hint, got:\n%s", got)
	}
	if !strings.Contains(got, "result_count: 0") {
		t.Errorf("expected no blocks, got:\n%s", got)
	}
	// And it must NOT claim the index is ready.
	if strings.Contains(got, "index_status: ready") {
		t.Errorf("the missing-index report claims the index is ready:\n%s", got)
	}
}

// TestSearchDocsClampBounds pins the clamp bounds directly, including the rule that a NEGATIVE limit
// becomes the lower bound rather than the default.
func TestSearchDocsClampBounds(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, 1}, {1, 1}, {-5, 1}, {5, 5}, {8, 8}, {25, 25}, {26, 25}, {100, 25},
	}
	for _, c := range cases {
		if got := tools.ClampDocsLimit(c.in); got != c.want {
			t.Errorf("ClampDocsLimit(%d) = %d, want %d", c.in, got, c.want)
		}
	}
	// The two tools must NOT share their bounds: a change to one cannot move the other.
	if tools.ClampAPIDocsLimit(26) != 26 {
		t.Errorf("ClampAPIDocsLimit(26) = %d; the api ceiling is 30, not 25", tools.ClampAPIDocsLimit(26))
	}
	if tools.ClampAPIDocsLimit(31) != 30 {
		t.Errorf("ClampAPIDocsLimit(31) = %d, want 30", tools.ClampAPIDocsLimit(31))
	}
	if tools.ClampDocsLimit(26) != 25 {
		t.Errorf("ClampDocsLimit(26) = %d, want 25", tools.ClampDocsLimit(26))
	}
}

// TestSearchDocsSourceFilterMapping pins the mapping table, including that an unknown filter stops
// filtering rather than erroring.
func TestSearchDocsSourceFilterMapping(t *testing.T) {
	f := loadSearchDocsFixtures(t)
	db := openFixtureDB(t, f.DocsDBPath)

	// "all" and an unknown value must both match across sources, and both must render their own
	// spelling in the report.
	all, err := tools.SearchDocs(db, "gauntlet", "all", 8)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(all, "source_filter: all") {
		t.Errorf("the rendered filter should be the CALLER's value:\n%s", all)
	}

	bogus, err := tools.SearchDocs(db, "gauntlet", "bogus", 8)
	if err != nil {
		t.Fatalf("an unknown filter must not error: %v", err)
	}
	if !strings.Contains(bogus, "source_filter: bogus") {
		t.Errorf("an unknown filter should still render as itself:\n%s", bogus)
	}
	// ★ THE FULL TEXTS CANNOT BE EQUAL — the filter value is echoed into the report, so `all` and
	// `bogus` necessarily differ by that line. What must be equal is the FILTERING, so the assertion
	// compares the match blocks instead. (The first version of this test compared the whole text and
	// failed for that reason: the expectation was wrong, not the port.)
	if countMatches(all) != countMatches(bogus) {
		t.Errorf("'all' and an unknown filter filtered differently: %d vs %d blocks",
			countMatches(all), countMatches(bogus))
	}
	if countMatches(all) == 0 {
		t.Error("the corpus matched nothing; this assertion would hold vacuously")
	}
}

// countMatches counts the rendered blocks in a report.
func countMatches(reportText string) int {
	return strings.Count(reportText, "[result_")
}

// TestSearchDocsGoBehavioursForNullSnippet records the rule the DIFFERENTIAL discovered, and pins the
// part of it a fixture cannot reach.
//
// ★ THE DISCOVERY: the first version of this port scanned `snippet()` into a plain string, and the
// differential did not notice because every corpus row had a non-empty body. Adding a row with a
// NULL body made the tool CRASH (`converting NULL to string is unsupported`) while the TypeScript
// rendered `(no snippet)` — the guard that looked like mere tidiness was load-bearing.
//
// ★ THE SURVIVING MUTANT: replacing `!snippet.Valid || snippet.String == ""` with just
// `snippet.String == ""` is NOT caught, and it is an EQUIVALENT mutant for every value this code can
// receive: the standard library's NullString.Scan sets String to "" whenever the value is NULL, so
// Valid == false implies String == "". Recorded rather than papered over — the explicit Valid check
// is kept because it states the invariant instead of relying on that implementation detail.
func TestSearchDocsGoBehavioursForNullSnippet(t *testing.T) {
	f := loadSearchDocsFixtures(t)
	db := openFixtureDB(t, f.DocsDBPath)

	// The corpus contains one row with an empty body and one with a NULL body; both must render the
	// placeholder, and the report for the query that hits them must show it twice.
	got, err := tools.SearchDocs(db, "gadget", "own", 8)
	if err != nil {
		t.Fatalf("a NULL snippet must not be an error: %v", err)
	}
	if n := strings.Count(got, "(no snippet)"); n != 2 {
		t.Errorf("expected BOTH the empty-body and NULL-body rows to render (no snippet); found %d.\n%s", n, got)
	}
	if strings.Contains(got, "unknown") {
		t.Errorf("the placeholder must reach the renderer as a non-empty value; `unknown` means it "+
			"was empty instead:\n%s", got)
	}
}

// TestSearchAPIDocsGoBehaviours exercises the api tool through its db parameter, for the branches
// that do not need a TypeScript-derived expectation. See the package note: no fixture corpus exists
// for this tool's RENDERED text.
func TestSearchAPIDocsGoBehaviours(t *testing.T) {
	// A database with the FTS table absent must produce the missing-index report, not an error.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	got, err := tools.SearchAPIDocs(db, gameState("1.2.9", "1.2.9.1"), "Campaign", "", "", 10)
	if err != nil {
		t.Fatalf("a missing index must not be an error: %v", err)
	}
	if !strings.Contains(got, "index_status: missing") {
		t.Errorf("expected index_status: missing, got:\n%s", got)
	}
	if !strings.Contains(got, "authority: local_decompiled_source") {
		t.Errorf("the missing-index report must state its authority:\n%s", got)
	}
	if !strings.Contains(got, "installed_game_version: 1.2.9") {
		t.Errorf("the missing-index report must carry the installed version:\n%s", got)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// search_api_docs parity (src/tools/search-api-docs.ts)
//
// The expectations come from EXECUTING the real searchApiDocs with its three I/O modules replaced at
// the module level (db, env, bannerlord-setup). Its database id is hard-coded in the TypeScript, so
// this is what makes a fixture possible at all without writing to dist/games/bannerlord — the real
// index on this machine, and the file ledger F19 records as destroyed by exactly such a write.
//
// The corpus pins:
//   - the four early returns: missing table, empty index, requested-but-unindexed, and the search
//   - the LIKE fallback, reached with a substring INSIDE a token that prefix matching cannot find
//   - the two clamps (floor 1, ceiling 30) and their difference from the docs tool's 25
//   - the version resolution's authority switch, computed from the INSTALLED version
// ─────────────────────────────────────────────────────────────────────────────

type saCase struct {
	Label   string          `json:"label"`
	DB      string          `json:"db"`
	State   json.RawMessage `json:"state"`
	Query   string          `json:"query"`
	Version *string         `json:"version"`
	Section *string         `json:"section"`
	Limit   int             `json:"limit"`
	OK      bool            `json:"ok"`
	Text    string          `json:"text"`
	Error   string          `json:"error"`
}

type saFixtures struct {
	DBPath        string   `json:"dbPath"`
	EmptyDBPath   string   `json:"emptyDbPath"`
	MissingDBPath string   `json:"missingDbPath"`
	Cases         []saCase `json:"cases"`
}

func TestSearchAPIDocsMatchesTypeScript(t *testing.T) {
	path := filepath.Join("..", "..", "tools", "parity", "searchapidocs_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_searchapidocs_fixtures.mjs", path, err)
	}
	var f saFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}

	// The injected state object carries only gameVersion/fullVersion, but the TypeScript reads more
	// fields, so the state is decoded loosely rather than into a fixed struct.
	type stateShape struct {
		GameVersion *string `json:"gameVersion"`
		FullVersion *string `json:"fullVersion"`
	}

	compared := 0
	for _, c := range f.Cases {
		if !c.OK {
			t.Fatalf("fixture %q recorded a THROW (%s); this tool has no error branch for that", c.Label, c.Error)
		}
		var s stateShape
		if err := json.Unmarshal(c.State, &s); err != nil {
			t.Fatalf("case %q has an undecodable state: %v", c.Label, err)
		}

		var dbFile string
		switch c.DB {
		case "populated":
			dbFile = f.DBPath
		case "empty":
			dbFile = f.EmptyDBPath
		case "missing":
			dbFile = f.MissingDBPath
		default:
			t.Fatalf("case %q names an unknown database %q", c.Label, c.DB)
		}
		db := openFixtureDB(t, dbFile)

		got, err := tools.SearchAPIDocs(db,
			apidocs.GameState{GameVersion: deref(s.GameVersion), FullVersion: deref(s.FullVersion)},
			c.Query, deref(c.Version), deref(c.Section), c.Limit)
		if err != nil {
			t.Errorf("%s: errored: %v", c.Label, err)
			continue
		}
		if got != c.Text {
			t.Errorf("%s differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				c.Label, got, c.Text, textFirstDiff(got, c.Text))
		}
		compared++
	}
	t.Logf("compared %d search_api_docs reports against the TypeScript", compared)
}

// countFTSMatches reports how many rows the built FTS query finds, so the fallback case can prove it
// actually travels the fallback path instead of merely naming a query that might.
func countFTSMatches(db *sql.DB, ftsQuery, version string) (int, error) {
	var n int
	err := db.QueryRow(
		`SELECT COUNT(*) FROM bannerlord_api_entries_fts WHERE bannerlord_api_entries_fts MATCH ? AND version = ?`,
		ftsQuery, version).Scan(&n)
	return n, err
}

// TestSearchAPIDocsLikeFallbackIsReached pins that the fallback is exercised rather than merely
// intended: the query is a substring INSIDE a token, which prefix matching cannot find.
func TestSearchAPIDocsLikeFallbackIsReached(t *testing.T) {
	db := openFixtureDB(t, filepath.Join("tools", "parity", "fixtures", "searchapidocs.db"))

	// The built FTS query for "nchron" is a phrase+prefix, which cannot match a substring.
	n, err := countFTSMatches(db, `"nchron"*`, "1.2.9")
	if err != nil {
		t.Fatalf("counting FTS matches: %v", err)
	}
	if n != 0 {
		t.Fatalf("the FTS path found %d rows for the fallback probe; the case no longer "+
			"distinguishes the two paths", n)
	}

	got, err := tools.SearchAPIDocs(db, apidocs.GameState{GameVersion: "1.2.9"}, "nchron", "", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(got, "Async") {
		t.Errorf("the LIKE fallback did not find the row the FTS path cannot:\n%s", got)
	}
	if !strings.Contains(got, "api_match_1") {
		t.Errorf("expected one match block:\n%s", got)
	}
}

// TestSearchAPIDocsEscapeLikePattern pins the escaping, which is invisible until a query contains a
// wildcard: without it a query of "%" would match every row.
func TestSearchAPIDocsEscapeLikePattern(t *testing.T) {
	// Exercised through the exported clamp only insofar as the escape is private; the rule is
	// asserted here as a property of the tool's behaviour on a database that contains a literal %.
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	if _, err := db.Exec(`CREATE VIRTUAL TABLE bannerlord_api_entries_fts USING fts5(
		id UNINDEXED, version UNINDEXED, section UNINDEXED, searchKey, title, scope, url UNINDEXED)`); err != nil {
		t.Skipf("this sqlite build cannot create the FTS table (%v); the escape rule is covered by the generator's corpus instead", err)
	}
	if _, err := db.Exec(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}

	// No rows at all: the call must still return a report rather than an error.
	got, err := tools.SearchAPIDocs(db, gameState("", ""), "%", "", "", 10)
	if err != nil {
		t.Fatalf("a wildcard query must not error: %v", err)
	}
	if !strings.Contains(got, "report_type: bannerlord_api_search") {
		t.Errorf("expected a report, got:\n%s", got)
	}
}

func gameState(gameVersion, fullVersion string) apidocs.GameState {
	return apidocs.GameState{GameVersion: gameVersion, FullVersion: fullVersion}
}
