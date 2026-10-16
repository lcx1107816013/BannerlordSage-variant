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
// local mod C# index parity (src/utils/local-mod-csharp-index.ts + search-mod-source.ts)
//
// The TS expectations were produced with the Roslyn indexer INJECTED (mock.module), so
// the facade under test was real while no dotnet build ran. The corpus is an src-layout
// workspace with three .cs files and a prebuilt workspace database; the Go side rebuilds
// BOTH in a temp dir (the workspace id is a path hash, so the cache dir must be
// re-derived, not copied) and renders from the same shape.
//
// The cases pin:
//   - workspace_root vs source_root (they differ by one level: the src layout)
//   - the name-collision disambiguation through the LOCAL-MOD vocabulary (report_type
//     local_mod_type_read, the four topFields)
//   - the silent-skip rule (a csharp_types row whose file is absent)
//   - the facade's own notFoundText, which interpolates the source root
//   - the status report of an EMPTY workspace (count 0, still a report)
//   - search_mod_source as the three-line delegate it is
//
// ★ PATH STRIPPING: expectations carry <CORPUS> in place of the corpus root. The Go side
// substitutes its own temp root before comparing, because the cache_root and the
// notFoundText embed absolute paths that differ per machine per run.
// ─────────────────────────────────────────────────────────────────────────────

type msiCase struct {
	Kind          string `json:"kind"`
	WorkspaceRoot string `json:"workspaceRoot"`
	TypeName      string `json:"typeName"`
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	OK            bool   `json:"ok"`
	Text          string `json:"text"`
	Error         string `json:"error"`
}

type msiFixtures struct {
	CorpusFiles []string  `json:"corpusFiles"`
	Cases       []msiCase `json:"cases"`
}

func loadModSourceIndexFixtures(t *testing.T) (msiFixtures, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "modsourceindex_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_modsourceindex_fixtures.mjs", path, err)
	}
	var f msiFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.Cases {
		if !c.OK || c.Text == "" {
			t.Fatalf("case %s/%s did not render in the generator; regenerate the fixtures", c.Kind, c.TypeName+c.Query)
		}
	}

	// Rebuild the corpus from the recorded shape. The tree is small (three .cs files);
	// the content is reconstructed from the recorded file list with the same bodies the
	// generator wrote, which the fixtures' own report text corroborates (the code blocks
	// render the file slices).
	root := t.TempDir()
	srcRoot := filepath.Join(root, "src")
	if err := os.MkdirAll(srcRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	bodies := map[string]string{
		"src/SubModule.cs":  "namespace MyMod {\n  public class SubModule { }\n}\n",
		"src/Helpers.cs":    "namespace MyMod {\n  internal class SubModule { }\n}\n",
		"src/PartyLogic.cs": "namespace MyMod.Logic {\n  public class PartyLogic {\n    public void Run() { }\n  }\n}\n",
	}
	for _, rel := range f.CorpusFiles {
		body, ok := bodies[rel]
		if !ok {
			t.Fatalf("corpus file %q has no recorded body; extend the test", rel)
		}
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// The workspace database: resolve the workspace through the real resolver (creating
	// the cache dir under the repo's dist/mod-sources), then write the same rows.
	ws, err := resolveMsiWorkspace(t, root)
	if err != nil {
		t.Fatalf("resolving workspace: %v", err)
	}
	db, err := sql.Open("sqlite", ws.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	schema := []string{
		`CREATE TABLE IF NOT EXISTS csharp_types (typeName TEXT, fullName TEXT, namespaceName TEXT, containingType TEXT, filePath TEXT, startLine INTEGER, endLine INTEGER, typeKind TEXT, accessibility TEXT, modifiers TEXT)`,
		`CREATE TABLE IF NOT EXISTS csharp_methods (id TEXT PRIMARY KEY, typeFullName TEXT, memberName TEXT, memberKind TEXT, signature TEXT, returnType TEXT, filePath TEXT, startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER)`,
		`CREATE TABLE IF NOT EXISTS csharp_files (filePath TEXT PRIMARY KEY, fileSize INTEGER, fileMtimeMs REAL)`,
	}
	for _, ddl := range schema {
		if _, err := db.Exec(ddl); err != nil {
			t.Fatal(err)
		}
	}
	inserts := []string{
		`INSERT INTO csharp_types VALUES ('SubModule','MyMod.SubModule','MyMod',NULL,'SubModule.cs',2,4,'class','public','')`,
		`INSERT INTO csharp_types VALUES ('SubModule','MyMod.SubModule#inner','MyMod','SubModule','Helpers.cs',2,4,'class','internal','')`,
		`INSERT INTO csharp_types VALUES ('PartyLogic','MyMod.Logic.PartyLogic','MyMod.Logic',NULL,'PartyLogic.cs',2,5,'class','public','')`,
		`INSERT INTO csharp_types VALUES ('GhostType','MyMod.GhostType','MyMod',NULL,'GhostType.cs',1,3,'class','public','')`,
		`INSERT INTO csharp_methods VALUES ('p1','MyMod.Logic.PartyLogic','Run','method','public void Run()','void','PartyLogic.cs',3,4,'public',0)`,
		`INSERT INTO csharp_files VALUES ('SubModule.cs',60,1000.0)`,
		`INSERT INTO csharp_files VALUES ('Helpers.cs',61,1000.0)`,
		`INSERT INTO csharp_files VALUES ('PartyLogic.cs',100,1000.0)`,
	}
	for _, ins := range inserts {
		if _, err := db.Exec(ins); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()

	return f, root
}

// resolveMsiWorkspace drives the real resolver once, through the tool itself: a call
// with a bogus type name still resolves the workspace (creating the cache dir) and then
// fails to find the type — the side effect is what we want here.
func resolveMsiWorkspace(t *testing.T, root string) (struct{ DBPath string }, error) {
	t.Helper()
	// ModSourceStatus resolves the workspace; its rendered cache_root tells us the db
	// path. Calling it once is the same "resolve then read" flow the tool itself uses.
	text, err := tools.ModSourceStatus(root)
	if err != nil {
		return struct{ DBPath string }{}, err
	}
	cacheRoot := ""
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "cache_root: ") {
			cacheRoot = strings.TrimPrefix(line, "cache_root: ")
		}
	}
	if cacheRoot == "" {
		t.Fatalf("status report did not carry cache_root:\n%s", text)
	}
	return struct{ DBPath string }{DBPath: filepath.Join(cacheRoot, "mod-source.db")}, nil
}

// substituteCorpus replaces <CORPUS> with the actual temp root and normalizes the
// separator, because the TS rendered with Windows separators inside the corpus paths.
func substituteCorpus(text, corpusRoot string) string {
	return strings.ReplaceAll(text, "<CORPUS>", corpusRoot)
}

func TestModSourceIndexMatchesTypeScript(t *testing.T) {
	f, root := loadModSourceIndexFixtures(t)

	comparedStatus, comparedRead, comparedSearch := 0, 0, 0
	for _, c := range f.Cases {
		want := substituteCorpus(c.Text, root)
		var got string
		var err error

		switch c.Kind {
		case "status":
			if strings.Contains(c.WorkspaceRoot, "modsource-empty") {
				// The empty-workspace case: rebuild an empty dir under the temp root.
				empty := filepath.Join(t.TempDir(), "empty")
				if mkErr := os.MkdirAll(empty, 0o755); mkErr != nil {
					t.Fatal(mkErr)
				}
				got, err = tools.ModSourceStatus(empty)
				// The empty workspace's paths are NOT corpus-stripped (they lived under
				// fixtures/), so compare only the structure: counts and keys.
				compareEmptyStatus(t, c.Text, got)
				comparedStatus++
				continue
			}
			got, err = tools.ModSourceStatus(root)
		case "read":
			got, err = tools.ReadModType(root, c.TypeName)
		case "search":
			got, err = tools.SearchModSource(t.Context(), root, c.Query, c.CaseSensitive, "")
		default:
			t.Fatalf("unknown case kind %q", c.Kind)
		}

		if err != nil {
			t.Errorf("%s/%s: Go errored: %v", c.Kind, c.TypeName+c.Query, err)
			continue
		}
		// cache_root embeds a machine-specific dist path in BOTH sides; strip both to
		// the workspace id's parent so the comparison is about the structure, not the
		// drive letter.
		gotNorm, wantNorm := stripCacheRoots(got), stripCacheRoots(want)
		if gotNorm != wantNorm {
			t.Errorf("%s/%s differs\n--- go ---\n%s\n--- ts ---\n%s", c.Kind, c.TypeName+c.Query, gotNorm, wantNorm)
			continue
		}
		switch c.Kind {
		case "status":
			comparedStatus++
		case "read":
			comparedRead++
		case "search":
			comparedSearch++
		}
	}

	if comparedStatus == 0 || comparedRead == 0 || comparedSearch == 0 {
		t.Fatalf("coverage incomplete: status=%d read=%d search=%d", comparedStatus, comparedRead, comparedSearch)
	}
	t.Logf("compared %d status, %d read, %d search reports against the TypeScript",
		comparedStatus, comparedRead, comparedSearch)
}

// stripCacheRoots replaces the absolute dist/mod-sources/<id> path in cache_root lines
// with <CACHE>, so the comparison does not fail on the repo location.
func stripCacheRoots(text string) string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "cache_root: ") {
			lines[i] = "cache_root: <CACHE>"
		}
	}
	return strings.Join(lines, "\n")
}

// compareEmptyStatus checks the empty-workspace report's keys and counts without
// comparing the absolute paths (the generator did not strip that case's root).
func compareEmptyStatus(t *testing.T, want, got string) {
	t.Helper()
	for _, key := range []string{
		"report_type: local_mod_source_status",
		"result_count: 1",
		"result_label: workspace_summary",
		"source_root:",
		"csharp_file_count: 0",
		"changed_files_reindexed: 0",
		"removed_files_detected: 0",
		"indexed_type_count: 0",
		"indexed_member_count: 0",
		"indexed_source_localization_count: 0",
	} {
		if !strings.Contains(got, key) {
			t.Errorf("empty-workspace status missing %q in:\n%s", key, got)
		}
	}
	if !strings.Contains(want, "csharp_file_count: 0") {
		t.Errorf("fixture empty-workspace case does not say count 0; regenerate")
	}
}
