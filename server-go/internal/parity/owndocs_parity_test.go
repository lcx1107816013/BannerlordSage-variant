package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"blore/internal/docsdb"
	"blore/internal/owndocs"
)

// ─────────────────────────────────────────────────────────────────────────────
// own-docs + docs-db parity (src/utils/own-docs.ts, src/utils/docs-db.ts)
//
// The expectations come from EXECUTING the real modules: the markdown corpus is read by the real
// walker and splitter, and the database expectations come from the real write path against a fresh
// fixture database.
//
// The corpus separates RULES rather than looking like documentation:
//
//   - frontmatter malformed in each of the three ways the strip function treats differently
//   - a `## ` line with nothing after it, which does NOT become a heading
//   - `### `, which stays body text
//   - a CJK heading (slug keeps it) and a kana heading (slug drops it and falls back)
//   - a hidden file and a file inside a hidden directory, which the walk skips
//   - a `.MD` file (walked) and a `.txt` (not)
//   - re-inserting the same rows, where the pages count holds and the FTS count grows
// ─────────────────────────────────────────────────────────────────────────────

type odTreeShape struct {
	Dirs  []string          `json:"dirs"`
	Files map[string]string `json:"files"`
}

type odPureCase struct {
	Kind   string          `json:"kind"`
	File   string          `json:"file"`
	Result json.RawMessage `json:"result"`
}

type odIDCase struct {
	Source string `json:"source"`
	URL    string `json:"url"`
	ID     string `json:"id"`
}

type odTitleCase struct {
	File   string `json:"file"`
	Result string `json:"result"`
}

type odWalkCase struct {
	Label string   `json:"label"`
	Dirs  []string `json:"dirs"`
	Files []string `json:"files"`
}

type odRowCase struct {
	ID        string `json:"id"`
	Source    string `json:"source"`
	Language  string `json:"language"`
	Category  string `json:"category"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	Content   string `json:"content"`
	IndexedAt string `json:"indexedAt"`
}

type odWriteCase struct {
	Kind    string          `json:"kind"`
	Rows    json.RawMessage `json:"rows"`
	Count   *int            `json:"count"`
	Objects json.RawMessage `json:"objects"`
}

type odFixtures struct {
	Shape         odTreeShape   `json:"shape"`
	KnowledgeRoot string        `json:"knowledgeRoot"`
	ExtraDir      string        `json:"extraDir"`
	DBPath        string        `json:"dbPath"`
	PureCases     []odPureCase  `json:"pureCases"`
	IDCases       []odIDCase    `json:"idCases"`
	TitleCases    []odTitleCase `json:"titleCases"`
	WalkCases     []odWalkCase  `json:"walkCases"`
	RowCases      []odRowCase   `json:"rowCases"`
	WriteCases    []odWriteCase `json:"writeCases"`
}

// mustAbs resolves a fixture path the same way Node does, so relative() on both sides agrees.
//
// ★ IT IS NOT OPTIONAL FOR THE ROOT. filepath.Rel returns an ERROR when one side is absolute and
// the other is not, and TitleFromFile's fallback then hands back the relative path unchanged — so
// five title cases and every row URL came out as `../../tools/...` while the originals said
// `../server-go/tools/...`. The loader therefore returns an absolute root, and this comment exists
// because "it is only a test path" is how that class of mistake gets made twice.
func mustAbs(t *testing.T, path string) string {
	t.Helper()
	abs, err := filepath.Abs(path)
	if err != nil {
		t.Fatal(err)
	}
	return abs
}

// repoKnowledgeRootAbs is the REPO's knowledge/ directory — the base titleFromFile and
// buildOwnDocRows use in the TypeScript, regardless of where the fixture tree lives.
func repoKnowledgeRootAbs(t *testing.T) string {
	t.Helper()
	repoRoot := mustAbs(t, filepath.Join("..", "..", ".."))
	return filepath.Join(repoRoot, "knowledge")
}

func loadOwnDocsFixtures(t *testing.T) (odFixtures, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "owndocs_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_owndocs_fixtures.mjs", path, err)
	}
	var f odFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.PureCases) == 0 || len(f.RowCases) == 0 || len(f.WriteCases) == 0 {
		t.Fatal("fixtures look incomplete; refusing to report success")
	}

	// ★ THE TREE IS REBUILT FROM THE SHAPE. It holds a HIDDEN DIRECTORY and (in the sibling corpus)
	// an empty one; git cannot represent either without a placeholder that would change what the
	// walker sees. Building from the same list the generator used is what keeps the two sides
	// describing one tree.
	root := mustAbs(t, filepath.Join("..", "..", "tools", "parity", "fixtures", "owndocs-tree"))
	buildTree(t, root, treeShape{Dirs: f.Shape.Dirs, Files: f.Shape.Files})

	return f, root
}

func TestOwnDocsSectionsMatchTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)

	byFile := map[string]string{}
	for rel, content := range f.Shape.Files {
		byFile[rel] = content
	}

	compared := 0
	for _, c := range f.PureCases {
		if c.Kind != "sections" {
			continue
		}
		content, ok := byFile[c.File]
		if !ok {
			t.Errorf("fixture names a file the shape does not contain: %s", c.File)
			continue
		}
		var want []owndocs.MarkdownSection
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatalf("case %s: undecodable result: %v", c.File, err)
		}
		got := owndocs.SplitMarkdownIntoSections(content)
		if len(got) != len(want) {
			t.Errorf("%s: %d sections, want %d\ngot:  %+v\nwant: %+v", c.File, len(got), len(want), got, want)
			continue
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%s: section %d = %+v, want %+v", c.File, i, got[i], want[i])
			}
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no section cases were compared")
	}
	t.Logf("compared %d section-split cases", compared)
}

func TestOwnDocsFrontmatterStripMatchesTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)

	// The fixture records the strip result as a string for the labelled inputs. The inputs are
	// reconstructed here from the same table the generator used, so a change to one side cannot
	// silently pass: the label names the input, and the inputs are spelled out in both places.
	inputs := map[string]string{
		"well formed":                      "---\na: b\n---\nbody",
		"no leading delimiter":             "body\n---\na: b\n---\nmore",
		"leading whitespace defeats it":    " ---\na: b\n---\nbody",
		"unclosed":                         "---\na: b\nno closer",
		"closer with no following newline": "---\na: b\n---",
		"closer at the very end":           "---\na: b\n---\n",
		"empty string":                     "",
		"just dashes":                      "---",
		"crlf frontmatter":                 "---\r\na: b\r\n---\r\nbody",
	}

	compared := 0
	for _, c := range f.PureCases {
		if c.Kind != "frontmatter" {
			continue
		}
		input, ok := inputs[c.File]
		if !ok {
			t.Errorf("fixture names an input label this test does not know: %q — add it", c.File)
			continue
		}
		var want string
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatalf("case %s: undecodable result: %v", c.File, err)
		}
		if got := owndocs.StripFrontmatter(input); got != want {
			t.Errorf("StripFrontmatter(%s) = %q, want %q", c.File, got, want)
		}
		compared++
	}
	t.Logf("compared %d frontmatter cases", compared)
}

func TestOwnDocsSlugifyMatchesTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)
	compared := 0
	for _, c := range f.PureCases {
		if c.Kind != "slugify" {
			continue
		}
		var want string
		if err := json.Unmarshal(c.Result, &want); err != nil {
			t.Fatalf("case %q: undecodable result: %v", c.File, err)
		}
		if got := owndocs.Slugify(c.File); got != want {
			t.Errorf("Slugify(%q) = %q, want %q", c.File, got, want)
		}
		compared++
	}
	t.Logf("compared %d slugify cases", compared)
}

func TestOwnDocsMakeDocIDMatchesTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)
	for _, c := range f.IDCases {
		if got := docsdb.MakeDocID(c.Source, c.URL); got != c.ID {
			t.Errorf("MakeDocID(%q, %q) = %q, want %q", c.Source, c.URL, got, c.ID)
		}
	}
	// The separator is part of the input: two sources indexing one url must not collide.
	a := docsdb.MakeDocID("own_knowledge", "u")
	b := docsdb.MakeDocID("official_moddocs", "u")
	if a == b {
		t.Error("two sources produced the same id for one url; the separator is not being hashed")
	}
	t.Logf("compared %d doc-id cases", len(f.IDCases))
}

func TestOwnDocsTitleMatchesTypeScript(t *testing.T) {
	f, root := loadOwnDocsFixtures(t)
	knowledgeRoot := filepath.Join(root, "knowledge")

	// ★ TWO THINGS ABOUT THE BASE, BOTH CAUGHT BY THE DIFFERENTIAL. The fallback is
	// `relative(knowledgeRoot(), filePath)` where the knowledge root belongs to the REPO, so a
	// fixture file gets a `../server-go/...` fallback rather than a path inside the fixture. And the
	// paths must be ABSOLUTE: filepath.Rel on two relative paths resolves both against the process
	// working directory and produces a different prefix than Node's relative(), which was given
	// absolute paths. Passing the same absolute inputs is what makes the comparison meaningful.
	repoKnowledgeRoot := repoKnowledgeRootAbs(t)

	compared := 0
	for _, c := range f.TitleCases {
		content, ok := f.Shape.Files[c.File]
		if !ok {
			t.Errorf("fixture names a file the shape does not contain: %s", c.File)
			continue
		}
		full := filepath.Join(root, filepath.FromSlash(c.File))
		if got := owndocs.TitleFromFile(content, full, repoKnowledgeRoot); got != c.Result {
			t.Errorf("TitleFromFile(%s) = %q, want %q", c.File, got, c.Result)
		}
		compared++
	}
	_ = knowledgeRoot
	t.Logf("compared %d title cases", compared)
}

func TestOwnDocsWalkMatchesTypeScript(t *testing.T) {
	f, root := loadOwnDocsFixtures(t)
	knowledgeRoot := filepath.Join(root, "knowledge")
	extraDir := filepath.Join(root, "extra")

	compared := 0
	for _, c := range f.WalkCases {
		var dirs []string
		for _, d := range c.Dirs {
			switch {
			case strings.HasSuffix(filepath.ToSlash(d), "/knowledge"):
				dirs = append(dirs, knowledgeRoot)
			case strings.HasSuffix(filepath.ToSlash(d), "/extra"):
				dirs = append(dirs, extraDir)
			case strings.Contains(filepath.ToSlash(d), "does-not-exist"):
				dirs = append(dirs, filepath.Join(root, "does-not-exist"))
			default:
				dirs = append(dirs, d)
			}
		}

		got := owndocs.ListOwnDocFiles(dirs)
		rel := make([]string, 0, len(got))
		for _, g := range got {
			r, err := filepath.Rel(root, g)
			if err != nil {
				t.Fatal(err)
			}
			rel = append(rel, filepath.ToSlash(r))
		}
		sort.Strings(rel)
		sort.Strings(c.Files)

		if len(rel) != len(c.Files) {
			t.Errorf("%s: %d files, want %d\ngot:  %v\nwant: %v", c.Label, len(rel), len(c.Files), rel, c.Files)
			continue
		}
		for i := range rel {
			if rel[i] != c.Files[i] {
				t.Errorf("%s: file %d = %q, want %q", c.Label, i, rel[i], c.Files[i])
			}
		}
		compared++
	}
	t.Logf("compared %d walk cases", compared)
}

func TestOwnDocsRowsMatchTypeScript(t *testing.T) {
	f, root := loadOwnDocsFixtures(t)
	knowledgeRoot := filepath.Join(root, "knowledge")
	extraDir := filepath.Join(root, "extra")

	files := owndocs.ListOwnDocFiles([]string{knowledgeRoot, extraDir})
	// The TypeScript passes its module-level knowledge root (the REPO's), not the fixture tree's.
	got, err := owndocs.BuildOwnDocRows(files, "2026-01-01T00:00:00.000Z", repoKnowledgeRootAbs(t))
	if err != nil {
		t.Fatal(err)
	}

	if len(got) != len(f.RowCases) {
		t.Fatalf("%d rows, want %d", len(got), len(f.RowCases))
	}
	// The TypeScript pushes rows in file order then section order; the Go side does too, so the
	// comparison is positional. A set comparison would hide an ordering regression.
	for i := range got {
		want := f.RowCases[i]
		if got[i].ID != want.ID || got[i].Source != want.Source || got[i].Language != want.Language ||
			got[i].Category != want.Category || got[i].Title != want.Title || got[i].URL != want.URL ||
			got[i].Content != want.Content || got[i].IndexedAt != want.IndexedAt {
			t.Errorf("row %d differs\ngot:  %+v\nwant: %+v", i, got[i], want)
		}
	}
	t.Logf("compared %d built rows", len(got))
}

// TestOwnDocsWritePathMatchesTypeScript replays the generator's database operations in the same
// order and compares every count and row it recorded.
func TestOwnDocsWritePathMatchesTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)

	// A DEDICATED database for the replay: the committed fixture is the generator's output, and
	// reusing it would let a previous run's rows satisfy a count that should have come from this one.
	dbFile := filepath.Join(t.TempDir(), "replay.db")
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := docsdb.EnsureSchema(db); err != nil {
		t.Fatal(err)
	}

	rows := make([]docsdb.DocRow, 0, len(f.RowCases))
	for _, r := range f.RowCases {
		rows = append(rows, docsdb.DocRow{
			ID: r.ID, Source: r.Source, Language: r.Language, Category: r.Category,
			Title: r.Title, URL: r.URL, Content: r.Content, IndexedAt: r.IndexedAt,
		})
	}
	sample := rows
	if len(sample) > 5 {
		sample = sample[:5]
	}

	byKind := map[string]odWriteCase{}
	for _, c := range f.WriteCases {
		byKind[c.Kind] = c
	}
	// ★ A CASE RECORDS EITHER ROWS OR A COUNT, and both are compared. The generator records rows
	// where the CONTENT matters and a count where only the number does; the first version of this
	// helper refused a rows case, which failed an assertion whose data was right there and stronger
	// than what it asked for.
	expectCount := func(kind string, got int) {
		t.Helper()
		c, ok := byKind[kind]
		if !ok {
			t.Errorf("fixture has no %q case", kind)
			return
		}
		if c.Count != nil {
			if got != *c.Count {
				t.Errorf("%s: count %d, want %d", kind, got, *c.Count)
			}
			return
		}
		// The fixture recorded rows: compare against their length, and say what was compared.
		var rows []map[string]any
		if err := json.Unmarshal(c.Rows, &rows); err != nil {
			t.Errorf("%s: recorded neither a count nor a decodable row set: %v", kind, err)
			return
		}
		if got != len(rows) {
			t.Errorf("%s: count %d, want %d (the fixture's row set)", kind, got, len(rows))
		}
	}

	if err := docsdb.UpsertSource(db, "own_knowledge", "first label", "first/", "zh-en", "T1"); err != nil {
		t.Fatal(err)
	}
	if err := docsdb.UpsertSource(db, "own_knowledge", "second label", "second/", "en", "T2"); err != nil {
		t.Fatal(err)
	}
	var label, baseURL, language, indexedAt string
	if err := db.QueryRow(`SELECT label, baseUrl, language, indexedAt FROM bannerlord_docs_sources WHERE source = 'own_knowledge'`).
		Scan(&label, &baseURL, &language, &indexedAt); err != nil {
		t.Fatal(err)
	}
	if label != "second label" || baseURL != "second/" || language != "en" || indexedAt != "T2" {
		want := byKind["sources-after-upsert"]
		t.Errorf("after the second upsert the row is %s/%s/%s/%s, want the second upsert's values (fixture: %s)",
			label, baseURL, language, indexedAt, want.Rows)
	}

	if err := docsdb.InsertDocRows(db, sample); err != nil {
		t.Fatal(err)
	}
	var pages, fts int
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_docs_pages`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	expectCount("pages-after-insert", pages)

	// ★ THE ROWS THEMSELVES, because the fixture recorded them: a count would pass if the ids were
	// wrong in a way that kept the total, and the id is what makes a previously indexed row reachable.
	if c, ok := byKind["pages-after-insert"]; ok {
		var want []struct {
			ID        string `json:"id"`
			Source    string `json:"source"`
			Language  string `json:"language"`
			Category  string `json:"category"`
			Title     string `json:"title"`
			URL       string `json:"url"`
			IndexedAt string `json:"indexedAt"`
		}
		if err := json.Unmarshal(c.Rows, &want); err != nil {
			t.Fatalf("pages-after-insert rows undecodable: %v", err)
		}
		gotRows, err := db.Query(`SELECT id, source, language, category, title, url, indexedAt FROM bannerlord_docs_pages ORDER BY id`)
		if err != nil {
			t.Fatal(err)
		}
		defer gotRows.Close()
		index := 0
		for gotRows.Next() {
			var id, source, language, category, title, url, indexedAt string
			if err := gotRows.Scan(&id, &source, &language, &category, &title, &url, &indexedAt); err != nil {
				t.Fatal(err)
			}
			if index >= len(want) {
				t.Errorf("more pages rows than the fixture recorded")
				break
			}
			w := want[index]
			if id != w.ID || source != w.Source || language != w.Language || category != w.Category ||
				title != w.Title || url != w.URL || indexedAt != w.IndexedAt {
				t.Errorf("pages row %d: got %s|%s|%s|%s|%s|%s|%s, want %s|%s|%s|%s|%s|%s|%s",
					index, id, source, language, category, title, url, indexedAt,
					w.ID, w.Source, w.Language, w.Category, w.Title, w.URL, w.IndexedAt)
			}
			index++
		}
		if index != len(want) {
			t.Errorf("compared %d pages rows, the fixture recorded %d", index, len(want))
		}
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_docs_fts`).Scan(&fts); err != nil {
		t.Fatal(err)
	}
	expectCount("fts-count", fts)

	// ★ THE ASYMMETRY. Re-inserting the same rows replaces the pages but APPENDS the FTS rows, so
	// pages holds while fts doubles. Pinned because it looks like a defect.
	if err := docsdb.InsertDocRows(db, sample); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_docs_pages`).Scan(&pages); err != nil {
		t.Fatal(err)
	}
	expectCount("pages-after-reinsert", pages)
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_docs_fts`).Scan(&fts); err != nil {
		t.Fatal(err)
	}
	expectCount("fts-after-reinsert", fts)

	// The prefix option in the schema is what makes the query builder's `"token"*` form work.
	var matched int
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_docs_fts WHERE bannerlord_docs_fts MATCH '"body"*'`).Scan(&matched); err != nil {
		t.Fatalf("the FTS table is not searchable: %v", err)
	}
	expectCount("fts-prefix-match", matched)

	if err := docsdb.DeleteDocsBySource(db, "own_knowledge"); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"pages-after-delete", "fts-after-delete", "sources-after-delete"} {
		var n int
		var q string
		switch kind {
		case "pages-after-delete":
			q = `SELECT COUNT(*) FROM bannerlord_docs_pages`
		case "fts-after-delete":
			q = `SELECT COUNT(*) FROM bannerlord_docs_fts`
		default:
			q = `SELECT COUNT(*) FROM bannerlord_docs_sources`
		}
		if err := db.QueryRow(q).Scan(&n); err != nil {
			t.Fatal(err)
		}
		expectCount(kind, n)
	}
}

// TestOwnDocsSchemaMatchesTypeScript compares the objects ensureDocsSchema creates.
func TestOwnDocsSchemaMatchesTypeScript(t *testing.T) {
	f, _ := loadOwnDocsFixtures(t)
	dbFile := filepath.Join(t.TempDir(), "schema.db")
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if err := docsdb.EnsureSchema(db); err != nil {
		t.Fatal(err)
	}
	// Idempotence: the function is meant to be callable before every write.
	if err := docsdb.EnsureSchema(db); err != nil {
		t.Fatalf("EnsureSchema is not idempotent: %v", err)
	}

	// The generator records this case as a BARE ARRAY of {type, name} — not an object wrapping one.
	var want []struct {
		Type string `json:"type"`
		Name string `json:"name"`
	}
	found := false
	for _, c := range f.WriteCases {
		if c.Kind == "schema" {
			if err := json.Unmarshal(c.Objects, &want); err != nil {
				t.Fatalf("schema case undecodable: %v", err)
			}
			found = true
		}
	}
	if !found || len(want) == 0 {
		t.Fatal("the fixture recorded no schema objects")
	}

	rows, err := db.Query(`SELECT type, name FROM sqlite_master WHERE name LIKE 'bannerlord_docs%' ORDER BY type, name`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	got := make([]string, 0, 16)
	for rows.Next() {
		var typ, name string
		if err := rows.Scan(&typ, &name); err != nil {
			t.Fatal(err)
		}
		got = append(got, typ+":"+name)
	}
	wanted := make([]string, 0, len(want))
	for _, o := range want {
		wanted = append(wanted, o.Type+":"+o.Name)
	}

	if len(got) != len(wanted) {
		t.Fatalf("schema objects:\ngot:  %v\nwant: %v", got, wanted)
	}
	for i := range got {
		if got[i] != wanted[i] {
			t.Errorf("schema object %d = %q, want %q", i, got[i], wanted[i])
		}
	}
	t.Logf("compared %d schema objects", len(got))
}
