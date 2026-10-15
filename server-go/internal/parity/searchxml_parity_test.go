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
// search_xml parity (src/tools/search-xml.ts)
//
// The tool runs a real FTS5 query, so this follows the store pattern: the generator built a
// database with a known corpus and recorded what the TypeScript rendered. The Go side opens
// the SAME committed database, so both sides provably query identical bytes.
//
// The rendered TEXT is compared, not a row set, because that text is what the client parses.
// ─────────────────────────────────────────────────────────────────────────────

type sxCorpusRow struct {
	FilePath   string `json:"filePath"`
	ModuleName string `json:"moduleName"`
	Content    string `json:"content"`
}

type sxResult struct {
	Query string `json:"query"`
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type sxFixtures struct {
	DBPath  string        `json:"dbPath"`
	Corpus  []sxCorpusRow `json:"corpus"`
	Results []sxResult    `json:"results"`
}

func loadSearchXMLFixtures(t *testing.T) (sxFixtures, *sql.DB) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "searchxml_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_searchxml_fixtures.mjs", path, err)
	}
	var f sxFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Results) == 0 || len(f.Corpus) == 0 {
		t.Fatalf("fixtures look empty (results=%d corpus=%d); refusing to report success",
			len(f.Results), len(f.Corpus))
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

	// ★ Verify the database still holds the corpus the fixtures describe. If it were
	// regenerated with different rows, every expectation would silently describe a
	// different database while the suite still reported PASS.
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM xml_documents_fts`).Scan(&count); err != nil {
		t.Fatalf("fixture database has no xml_documents_fts: %v", err)
	}
	if count != len(f.Corpus) {
		t.Fatalf("fixture database holds %d rows but the fixtures describe %d; regenerate them",
			count, len(f.Corpus))
	}
	for _, row := range f.Corpus {
		var n int
		if err := db.QueryRow(
			`SELECT count(*) FROM xml_documents_fts WHERE filePath = ? AND moduleName = ?`,
			row.FilePath, row.ModuleName).Scan(&n); err != nil {
			t.Fatalf("corpus check failed for %s: %v", row.FilePath, err)
		}
		if n != 1 {
			t.Fatalf("corpus row missing or duplicated: %s / %s (found %d)", row.FilePath, row.ModuleName, n)
		}
	}
	return f, db
}

func TestSearchXMLMatchesTypeScript(t *testing.T) {
	f, db := loadSearchXMLFixtures(t)

	compared := 0
	for _, r := range f.Results {
		if !r.OK {
			continue
		}
		got, err := tools.SearchXML(db, r.Query)
		if err != nil {
			t.Errorf("SearchXML(%q) errored: %v", r.Query, err)
			continue
		}
		if got != r.Text {
			t.Errorf("SearchXML(%q) differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				r.Query, got, r.Text, textFirstDiff(got, r.Text))
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no search_xml queries were compared")
	}
	t.Logf("compared %d search_xml reports against the TypeScript output", compared)

	// ★ The zero-match branch must produce a report with result_count: 0 and NO block
	// header. The TypeScript returns early there, and unifying the two branches would
	// change the output.
	var zero *sxResult
	for i := range f.Results {
		if f.Results[i].Query == "nothing-matches-this-at-all" {
			zero = &f.Results[i]
			break
		}
	}
	if zero == nil || !zero.OK {
		t.Fatal("the corpus no longer contains a zero-match query; that branch is untested")
	}
	if !strings.Contains(zero.Text, "result_count: 0") {
		t.Errorf("zero-match fixture does not report result_count: 0:\n%s", zero.Text)
	}
	if strings.Contains(zero.Text, "[result_1]") {
		t.Errorf("zero-match fixture unexpectedly contains a block:\n%s", zero.Text)
	}
	got, err := tools.SearchXML(db, zero.Query)
	if err != nil {
		t.Fatalf("SearchXML(zero-match) errored: %v", err)
	}
	if strings.Contains(got, "[result_1]") {
		t.Errorf("the port rendered a block for a zero-match query:\n%s", got)
	}

	// ★ bm25 weighting must actually be in play: the row whose FILE PATH contains
	// "gauntlet" must rank above the rows where it only appears in the content. If the port
	// dropped the ORDER BY, the order would follow rowid and this would fail.
	var g *sxResult
	for i := range f.Results {
		if f.Results[i].Query == "gauntlet" {
			g = &f.Results[i]
			break
		}
	}
	if g == nil || !g.OK {
		t.Fatal("the corpus no longer contains the 'gauntlet' query; bm25 ordering is untested")
	}
	firstPath := firstFieldValue(g.Text, "file_path:")
	if firstPath != "Modules/SandBox/GUI/gauntlet/C.xml" {
		t.Fatalf("fixture ordering is not bm25-weighted: first file_path is %q", firstPath)
	}
	gotGauntlet, err := tools.SearchXML(db, "gauntlet")
	if err != nil {
		t.Fatalf("SearchXML(gauntlet) errored: %v", err)
	}
	if firstFieldValue(gotGauntlet, "file_path:") != firstPath {
		t.Errorf("the port's ordering is not bm25-weighted:\n%s", gotGauntlet)
	}
	t.Logf("bm25 weighting verified: %q ranks first (filePath weight 8.0)", firstPath)
}

// firstFieldValue returns the value of the first line beginning with prefix.
func firstFieldValue(text, prefix string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, prefix) {
			return strings.TrimSpace(strings.TrimPrefix(line, prefix))
		}
	}
	return ""
}
