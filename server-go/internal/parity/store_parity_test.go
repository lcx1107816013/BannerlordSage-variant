package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/store"
)

// ─────────────────────────────────────────────────────────────────────────────
// store parity (src/utils/db.ts)
//
// These helpers are IO-bound, so the technique differs from the pure-function units:
// instead of many inputs to one function, the generator builds ONE real SQLite database
// with deliberate edge cases and records what the TypeScript returns for each probe.
// This test opens the SAME database file (committed alongside the fixtures, so both
// sides provably read identical bytes) and requires the same answers.
//
// The probes exist to pin behaviours a "reasonable" port gets wrong:
//   - a VIEW must not answer true for hasTable (the previous version used
//     `type IN ('table','view')`)
//   - the port must not silently report 0/"" on error instead of matching the TS, and
//     must not report success where the TS reports undefined
//   - textValue must NOT coerce a numeric column into its decimal text
//   - identifiers needing quotes (a space, an embedded double quote) must work the same
// ─────────────────────────────────────────────────────────────────────────────

type storeHasTableProbe struct {
	Table string `json:"table"`
	Want  bool   `json:"want"`
}

type storeHasColumnsProbe struct {
	Table   string   `json:"table"`
	Columns []string `json:"columns"`
	Want    bool     `json:"want"`
}

type storeRowCountProbe struct {
	Table string `json:"table"`
	Want  int    `json:"want"`
}

type storeRowCountWhereProbe struct {
	Table  string `json:"table"`
	Column string `json:"column"`
	Value  string `json:"value"`
	Want   int    `json:"want"`
}

type storeTextValueProbe struct {
	Table       string  `json:"table"`
	KeyColumn   string  `json:"keyColumn"`
	KeyValue    string  `json:"keyValue"`
	ValueColumn string  `json:"valueColumn"`
	Want        *string `json:"want"` // null == the TypeScript returned undefined
}

type storeProbes struct {
	HasTable            []storeHasTableProbe      `json:"hasTable"`
	HasColumns          []storeHasColumnsProbe    `json:"hasColumns"`
	RowCount            []storeRowCountProbe      `json:"rowCount"`
	RowCountWhereEquals []storeRowCountWhereProbe `json:"rowCountWhereEquals"`
	TextValue           []storeTextValueProbe     `json:"textValue"`
}

type storeFixtures struct {
	DBFile string      `json:"dbFile"`
	Probes storeProbes `json:"probes"`
}

func loadStoreFixtures(t *testing.T) (storeFixtures, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "store_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_store_fixtures.mjs", path, err)
	}
	var f storeFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}

	// An empty probe set would make every loop below pass vacuously — the failure mode
	// that has already bitten this project three times.
	total := len(f.Probes.HasTable) + len(f.Probes.HasColumns) + len(f.Probes.RowCount) +
		len(f.Probes.RowCountWhereEquals) + len(f.Probes.TextValue)
	if total == 0 {
		t.Fatal("fixtures contain no probes; refusing to report success")
	}

	// The database is the OTHER half of the fixture. If it is missing the comparison
	// would silently degrade to "everything returns false / 0", which is exactly the
	// wrong answer shape, so it is an error rather than a skip.
	dbPath := filepath.Join("..", "..", "tools", "parity", "fixtures", f.DBFile)
	if _, err := os.Stat(dbPath); err != nil {
		t.Fatalf("probe database missing (%s): %v\nregenerate the fixtures", dbPath, err)
	}
	return f, dbPath
}

func TestStoreProbesMatchTypeScript(t *testing.T) {
	f, dbPath := loadStoreFixtures(t)

	// ★ The view case is asserted FIRST and separately, because it is the one the
	// previous implementation got wrong (`type IN ('table','view')`). If the corpus ever
	// loses this probe the guarantee would quietly disappear.
	viewCount := 0
	for _, p := range f.Probes.HasTable {
		if p.Table == "items_view" {
			viewCount++
			if p.Want {
				t.Fatalf("fixture expects hasTable(view)=true, but the TypeScript returns false; "+
					"the fixtures are out of date: %+v", p)
			}
		}
	}
	if viewCount == 0 {
		t.Fatal("no view probe in the corpus — the table-vs-view distinction is not being tested")
	}

	ran := 0
	for _, p := range f.Probes.HasTable {
		got := store.HasTable(dbPath, p.Table)
		if got != p.Want {
			t.Errorf("HasTable(%q) = %v, want %v (TypeScript)", p.Table, got, p.Want)
		}
		ran++
	}

	for _, p := range f.Probes.HasColumns {
		got := store.HasColumns(dbPath, p.Table, p.Columns)
		if got != p.Want {
			t.Errorf("HasColumns(%q, %v) = %v, want %v (TypeScript)", p.Table, p.Columns, got, p.Want)
		}
		ran++
	}

	for _, p := range f.Probes.RowCount {
		got := store.TableRowCount(dbPath, p.Table)
		if got != p.Want {
			t.Errorf("TableRowCount(%q) = %d, want %d (TypeScript)", p.Table, got, p.Want)
		}
		ran++
	}

	for _, p := range f.Probes.RowCountWhereEquals {
		got := store.TableRowCountWhereEquals(dbPath, p.Table, p.Column, p.Value)
		if got != p.Want {
			t.Errorf("TableRowCountWhereEquals(%q, %q, %q) = %d, want %d (TypeScript)",
				p.Table, p.Column, p.Value, got, p.Want)
		}
		ran++
	}

	for _, p := range f.Probes.TextValue {
		got, ok := store.TextValue(dbPath, p.Table, p.KeyColumn, p.KeyValue, p.ValueColumn)
		if p.Want == nil {
			// The TypeScript returned undefined. The port must agree: an empty string
			// here would be a different answer, not an equivalent one.
			if ok {
				t.Errorf("TextValue(%q, %q=%q, %q) = (%q, true), want undefined (TypeScript)",
					p.Table, p.KeyColumn, p.KeyValue, p.ValueColumn, got)
			}
		} else {
			if !ok {
				t.Errorf("TextValue(%q, %q=%q, %q) = (_, false), want %q (TypeScript)",
					p.Table, p.KeyColumn, p.KeyValue, p.ValueColumn, *p.Want)
			} else if got != *p.Want {
				t.Errorf("TextValue(%q, %q=%q, %q) = %q, want %q (TypeScript)",
					p.Table, p.KeyColumn, p.KeyValue, p.ValueColumn, got, *p.Want)
			}
		}
		ran++
	}

	t.Logf("compared %d store probes against the TypeScript output (%d hasTable, %d hasColumns, %d rowCount, %d whereEquals, %d textValue)",
		ran, len(f.Probes.HasTable), len(f.Probes.HasColumns), len(f.Probes.RowCount),
		len(f.Probes.RowCountWhereEquals), len(f.Probes.TextValue))
}
