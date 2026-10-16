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
// bannerlord_index_status parity (src/tools/bannerlord-index-status.ts)
//
// The TS expectations were produced with env/setup/db/runtime-revision injected via
// mock.module, against a miniature install (fixtures/indexstatus-game), a state dir
// (fixtures/indexstatus-state) holding the setup-state JSON, Version.txt, the parse
// report and the index database. The Go side rebuilds ALL of it in a temp dir and drives
// the same shape through BLORE_ROOT (env.GetGamePaths derives dist/games/<id> from it).
//
// The corpus makes the sharp edges observable:
//   - two missing official DLLs (a module dll and a root-bin dll) against two indexed
//     ones; a community module's dll is never a candidate
//   - db_present as the STRING 'true', parse failures from the report JSON
//   - the api authority from the version resolution (exact match -> official_api_reference)
//   - the DEAD editor filter: 'bannerlord_editor_' against archived 'ba_editor_*' names
//     never matches, so experimental_editor_tools renders '- none'
// ─────────────────────────────────────────────────────────────────────────────

type isCase struct {
	Label string `json:"label"`
	GameID string `json:"gameId"`
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type isStateSpec struct {
	GameVersion      string            `json:"gameVersion"`
	BuildChangeset   string            `json:"buildChangeset"`
	FullVersion      string            `json:"fullVersion"`
	VersionSource    string            `json:"versionSource"`
	DLLScope         string            `json:"dllScope"`
	XMLScope         string            `json:"xmlScope"`
	DLLs             map[string]string `json:"dlls"`
	XMLFiles         map[string]int    `json:"xmlFiles"`
	RuntimeRevision  string            `json:"runtimeRevision"`
	ParseFailureCount int              `json:"parseFailureCount"`
}

type isFixtures struct {
	GameTree map[string]string `json:"gameTree"`
	State    isStateSpec       `json:"state"`
	Cases    []isCase          `json:"cases"`
}

func loadIndexStatusFixtures(t *testing.T) (isFixtures, string, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "indexstatus_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_indexstatus_fixtures.mjs", path, err)
	}
	var f isFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.Cases {
		if !c.OK || c.Text == "" {
			t.Fatalf("case %q did not render; regenerate the fixtures", c.Label)
		}
	}

	// Rebuild the miniature install.
	gameDir := t.TempDir()
	for rel, body := range f.GameTree {
		full := filepath.Join(gameDir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// Rebuild the state dir as dist/games/bannerlord under a temp root.
	stateRoot := t.TempDir()
	gameDist := filepath.Join(stateRoot, "dist", "games", "bannerlord")
	if err := os.MkdirAll(gameDist, 0o755); err != nil {
		t.Fatal(err)
	}

	setupState := map[string]any{
		"version":         2,
		"gameDir":         gameDir,
		"gameVersion":     f.State.GameVersion,
		"buildChangeset":  f.State.BuildChangeset,
		"fullVersion":     f.State.FullVersion,
		"versionSource":   f.State.VersionSource,
		"dllScope":        f.State.DLLScope,
		"xmlScope":        f.State.XMLScope,
		"dlls":            map[string]any{},
		"xmlFiles":        map[string]any{},
	}
	for key := range f.State.DLLs {
		setupState["dlls"].(map[string]any)[key] = map[string]any{
			"md5": "x", "sourceFile": "a", "outputDir": "b", "updatedAt": "t",
		}
	}
	for key := range f.State.XMLFiles {
		setupState["xmlFiles"].(map[string]any)[key] = map[string]any{
			"sourceFile": key, "size": 1, "mtimeMs": 1.0, "updatedAt": "t",
		}
	}
	setupRaw, _ := json.Marshal(setupState)
	if err := os.WriteFile(filepath.Join(gameDist, "setup-state.json"), setupRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(gameDist, "Version.txt"), []byte(f.State.RuntimeRevision+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// The parse report lives under <gameDist>/reports/.
	if err := os.MkdirAll(filepath.Join(gameDist, "reports"), 0o755); err != nil {
		t.Fatal(err)
	}
	parseRaw, _ := json.Marshal(map[string]int{"parseFailureCount": f.State.ParseFailureCount})
	if err := os.WriteFile(filepath.Join(gameDist, "reports", "xml-parse-report.json"), parseRaw, 0o644); err != nil {
		t.Fatal(err)
	}

	// The index database: same table shapes and counts the generator created.
	dbPath := filepath.Join(gameDist, "bannerlord.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatal(err)
	}
	ddl := []string{
		`CREATE TABLE csharp_types (id INTEGER)`,
		`INSERT INTO csharp_types VALUES (1),(2),(3)`,
		`CREATE TABLE csharp_methods (id INTEGER)`,
		`INSERT INTO csharp_methods VALUES (1)`,
		`CREATE TABLE source_localization_entries (id INTEGER)`,
		`CREATE TABLE xml_entities (id INTEGER)`,
		`CREATE TABLE localization_entries (id INTEGER)`,
		`INSERT INTO localization_entries VALUES (1),(2)`,
		`CREATE TABLE bannerlord_items (id INTEGER)`,
		`CREATE TABLE bannerlord_troops (id INTEGER)`,
		`CREATE TABLE bannerlord_heroes (id INTEGER)`,
		`CREATE TABLE bannerlord_clans (id INTEGER)`,
		`CREATE TABLE bannerlord_kingdoms (id INTEGER)`,
		`CREATE TABLE bannerlord_settlements (id INTEGER)`,
		`CREATE TABLE bannerlord_cultures (id INTEGER)`,
		`CREATE TABLE bannerlord_skills (id INTEGER)`,
		`CREATE TABLE bannerlord_policies (id INTEGER)`,
		`CREATE TABLE bannerlord_perks (id INTEGER)`,
		`CREATE TABLE bannerlord_docs_pages (id INTEGER, source TEXT)`,
		`INSERT INTO bannerlord_docs_pages VALUES (1,'official_moddocs'),(2,'official_moddocs'),(3,'community_modding_docs')`,
		`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`,
		`INSERT INTO bannerlord_api_versions VALUES ('1.2.9')`,
		`CREATE TABLE bannerlord_api_entries (id TEXT, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT)`,
		`INSERT INTO bannerlord_api_entries VALUES ('a1','1.2.9','classes','Hero','Hero','class Hero','https://api/1')`,
	}
	for _, stmt := range ddl {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("building fixture db (%s): %v", stmt, err)
		}
	}
	db.Close()

	return f, gameDir, stateRoot
}

func TestIndexStatusMatchesTypeScript(t *testing.T) {
	f, gameDir, stateRoot := loadIndexStatusFixtures(t)

	// Redirect the root so env.GetGamePaths('bannerlord') lands on the temp state dir.
	t.Setenv("BLORE_ROOT", stateRoot)
	// The toolset mode the TS ran under: unset BANNERSAGE_TOOLSET -> full.
	os.Unsetenv("BANNERSAGE_TOOLSET")

	compared := 0
	for _, c := range f.Cases {
		got, err := tools.IndexStatus(c.GameID, os.LookupEnv)
		if err != nil {
			t.Errorf("%s: Go errored: %v", c.Label, err)
			continue
		}
		want := strings.ReplaceAll(c.Text, "<GAME>", gameDir)
		if got != want {
			t.Errorf("%s differs\n--- go ---\n%s\n--- ts ---\n%s", c.Label, got, want)
			continue
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no cases were compared")
	}
	t.Logf("compared %d index-status reports against the TypeScript output, byte for byte", compared)
}

// TestIndexStatusMissingDLLNames pins the two missing DLLs the corpus makes visible, so
// a walker regression fails with a name, not a byte wall.
func TestIndexStatusMissingDLLNames(t *testing.T) {
	f, _, stateRoot := loadIndexStatusFixtures(t)
	t.Setenv("BLORE_ROOT", stateRoot)
	os.Unsetenv("BANNERSAGE_TOOLSET")

	got, err := tools.IndexStatus("bannerlord", os.LookupEnv)
	if err != nil {
		t.Fatalf("Go errored: %v", err)
	}
	if !strings.Contains(got, "- SandBox.dll") {
		t.Errorf("missing_official_dlls lacks SandBox.dll (the unindexed official module dll)")
	}
	if !strings.Contains(got, "- TaleWorlds.Engine.dll") {
		t.Errorf("missing_official_dlls lacks TaleWorlds.Engine.dll (the unindexed root-bin dll)")
	}
	if strings.Contains(got, "CommunityMod.dll") {
		t.Errorf("community module dll must never appear in missing_official_dlls")
	}
	if strings.Contains(got, "TaleWorlds.MountAndBlade.View.dll") {
		t.Errorf("the indexed Native dll must not appear in missing_official_dlls")
	}
	_ = f
}
