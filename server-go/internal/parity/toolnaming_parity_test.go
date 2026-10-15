package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/toolnaming"
)

// ─────────────────────────────────────────────────────────────────────────────
// tool-naming parity (src/utils/tool-naming.ts)
//
// Both exports are public and were executed directly by the generator. The corpus separates rules
// that look alike:
//
//   - the legacy prefix is stripped ONLY AT THE START: `x_bannerlord_y` keeps its inner occurrence
//   - ONLY THE FIRST match is stripped: `bannerlord_bannerlord_doctor` -> `ba_bannerlord_doctor`
//   - a name already carrying `ba_` is NOT special-cased: `ba_doctor` -> `ba_ba_doctor`
//   - the comparison is CASE-SENSITIVE: `BANNERLORD_doctor` is not stripped
//
// The third one matters beyond tidiness: this module exists because a rename applied in two places
// produced a doubled prefix, so the function's own double-application behaviour is the defect it
// documents — pinned here rather than "fixed", because the fix belongs at the call site.
// ─────────────────────────────────────────────────────────────────────────────

type tnCase struct {
	LegacyName string `json:"legacyName"`
	Name       string `json:"name"`
	PairName   string `json:"pairName"`
	PairLegacy string `json:"pairLegacy"`
}

type tnFixtures struct {
	ArchivePrefix string   `json:"archivePrefix"`
	Cases         []tnCase `json:"cases"`
}

func loadToolNamingFixtures(t *testing.T) tnFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "toolnaming_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_toolnaming_fixtures.mjs", path, err)
	}
	var f tnFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	return f
}

func TestToolNamingMatchesTypeScript(t *testing.T) {
	f := loadToolNamingFixtures(t)

	if toolnaming.ArchivePrefix != f.ArchivePrefix {
		t.Errorf("ArchivePrefix = %q, want %q", toolnaming.ArchivePrefix, f.ArchivePrefix)
	}
	if len(toolnaming.LegacyPrefixes) == 0 {
		t.Error("LegacyPrefixes is empty; the prefix that must be stripped is gone")
	}

	for _, c := range f.Cases {
		got := toolnaming.ArchiveToolName(c.LegacyName)
		if got != c.Name {
			t.Errorf("ArchiveToolName(%q) = %q, want %q", c.LegacyName, got, c.Name)
		}
		gotName, gotLegacy := toolnaming.ArchiveTool(c.LegacyName)
		if gotName != c.PairName || gotLegacy != c.PairLegacy {
			t.Errorf("ArchiveTool(%q) = (%q, %q), want (%q, %q)",
				c.LegacyName, gotName, gotLegacy, c.PairName, c.PairLegacy)
		}
	}
	t.Logf("compared %d tool-name cases against the TypeScript", len(f.Cases))
}

// TestToolNamingStripsOnlyAtTheStart pins the rule a Replace-based port would break.
func TestToolNamingStripsOnlyAtTheStart(t *testing.T) {
	if got := toolnaming.ArchiveToolName("x_bannerlord_y"); got != "ba_x_bannerlord_y" {
		t.Errorf("ArchiveToolName(\"x_bannerlord_y\") = %q; the prefix is stripped only at the START", got)
	}
	if got := toolnaming.ArchiveToolName("bannerlord_x"); got != "ba_x" {
		t.Errorf("ArchiveToolName(\"bannerlord_x\") = %q, want ba_x", got)
	}
}

// TestToolNamingStripsOnlyOnce pins the single-strip rule, which is invisible with one legacy
// prefix and becomes load-bearing the moment a second one is added.
func TestToolNamingStripsOnlyOnce(t *testing.T) {
	if got := toolnaming.ArchiveToolName("bannerlord_bannerlord_doctor"); got != "ba_bannerlord_doctor" {
		t.Errorf("a doubled legacy prefix produced %q; only the FIRST match is stripped", got)
	}
}

// TestToolNamingDoesNotGuardAgainstDoubleApplication records the behaviour rather than endorsing it:
// the function does not detect that a name is already prefixed. The corpus agrees, and the guard
// belongs at the call site — this module's own comment explains that applying a rename in two
// places is the defect it was written to end.
func TestToolNamingDoesNotGuardAgainstDoubleApplication(t *testing.T) {
	if got := toolnaming.ArchiveToolName("ba_doctor"); got != "ba_ba_doctor" {
		t.Errorf("ArchiveToolName(\"ba_doctor\") = %q; the original does not special-case an already-prefixed name", got)
	}
}
