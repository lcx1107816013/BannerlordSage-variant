package parity_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/apidocs"
	"blore/internal/sandbox"
	"blore/internal/tools"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// search_bannerlord_knowledge parity (src/tools/search-knowledge.ts)
//
// The orchestration under test: intent routing, query builders, safeSearch degradation,
// block assembly, the 80-line nested truncation, the limit clamp. The three sub-search
// bodies have their own parity suites; the fixtures here exercise the tool through the
// REAL TypeScript with db/env/setup injected and a real ripgrep over a committed corpus.
//
// ★ A LABEL THE FIXTURES CORRECTED BEFORE THE GO SIDE EVER RAN: the case labelled
// 'harmony keyword -> make_mod' actually resolves to API, because resolveIntent tests
// the api-keyword regex FIRST and the query contains the word 'method'. The TS is the
// truth; the label describes a wrong expectation I had while designing the corpus. Kept
// as-is (the text is what matters) with this note, per the README's discipline that
// expectations come from execution, not from reading.
// ─────────────────────────────────────────────────────────────────────────────

type skCase struct {
	Label string `json:"label"`
	Query string `json:"query"`
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type skFixtures struct {
	DBPath      string   `json:"dbPath"`
	CorpusFiles []string `json:"corpusFiles"`
	Cases       []skCase `json:"cases"`
}

func loadSearchKnowledgeFixtures(t *testing.T) (skFixtures, *sql.DB, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "searchknowledge_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_searchknowledge_fixtures.mjs", path, err)
	}
	var f skFixtures
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

	dbFile := filepath.Join("..", "..", f.DBPath)
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatalf("cannot open fixture database: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	corpus := filepath.Join("..", "..", "tools", "parity", "fixtures", "searchknowledge-corpus")
	if _, err := os.Stat(corpus); err != nil {
		t.Fatalf("corpus missing (%s): %v", corpus, err)
	}
	return f, db, corpus
}

func TestSearchKnowledgeMatchesTypeScript(t *testing.T) {
	f, db, corpus := loadSearchKnowledgeFixtures(t)

	// The injected setup state the TS saw: version 1.2.9, full 1.2.9.1, gameDir D:/FixtureGame.
	state := apidocs.GameState{GameVersion: "1.2.9", FullVersion: "1.2.9.1"}
	box := sandbox.New("", corpus)

	compared := 0
	for _, c := range f.Cases {
		// The three explicit-intent cases are driven by TestSearchKnowledgeExplicitIntents
		// with their own intent values; passing 'auto' here would misroute them.
		switch c.Label {
		case "explicit docs intent skips api and source",
			"explicit api intent skips docs",
			"explicit source intent skips docs and api":
			continue
		}
		got, err := tools.SearchKnowledge(context.Background(), db, state, box, c.Query, "auto", 5)
		if err != nil {
			t.Errorf("%s: Go errored: %v", c.Label, err)
			continue
		}
		if got != c.Text {
			t.Errorf("%s differs\n--- go ---\n%s\n--- ts ---\n%s", c.Label, got, c.Text)
			continue
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no cases were compared")
	}
	t.Logf("compared %d knowledge-search reports against the TypeScript output, byte for byte", compared)
}

// TestSearchKnowledgeExplicitIntents drives the two explicit intents whose cases carry
// non-auto intents in the fixtures (the main loop passes 'auto' for every case; the
// fixture text was produced with the case's own intent, so those two cases need their
// intent passed through).
func TestSearchKnowledgeExplicitIntents(t *testing.T) {
	f, db, corpus := loadSearchKnowledgeFixtures(t)
	state := apidocs.GameState{GameVersion: "1.2.9", FullVersion: "1.2.9.1"}
	box := sandbox.New("", corpus)

	compared := 0
	for _, c := range f.Cases {
		var intent string
		switch c.Label {
		case "explicit docs intent skips api and source":
			intent = "docs"
		case "explicit api intent skips docs":
			intent = "api"
		case "explicit source intent skips docs and api":
			intent = "source"
		default:
			continue
		}
		got, err := tools.SearchKnowledge(context.Background(), db, state, box, c.Query, intent, 5)
		if err != nil {
			t.Errorf("%s: Go errored: %v", c.Label, err)
			continue
		}
		if got != c.Text {
			t.Errorf("%s differs\n--- go ---\n%s\n--- ts ---\n%s", c.Label, got, c.Text)
			continue
		}
		compared++
	}
	if compared != 3 {
		t.Fatalf("expected 3 explicit-intent cases, compared %d", compared)
	}
}
