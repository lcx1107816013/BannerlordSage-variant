package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/tools"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// generate_harmony_patch parity (src/tools/generate-harmony-patch.ts)
//
// The corpus is a crafted AST index (csharp_types + csharp_methods); the expectations
// are the TypeScript's rendered template against that same committed database. The
// corpus separates the template's branches:
//
//   - the SHORTEST fullName wins the type row (ORDER BY LENGTH(fullName), filePath)
//   - one instance method -> the spliced `${className} __instance, ` parameter
//   - several overloads with an instance one among them -> the marker comment
//   - all-static methods -> an empty hint
//   - generic/array/modifier/default parameters -> buildTypeHint's split-at-depth-0,
//     modifier strip and default-value split, all observable in the rendered hints
//   - a signature with no parens -> no Overload hint line under the comment
//   - type present, method absent -> the fixed "not found in the AST index" sentence
//   - type absent -> "Type not found: X" as a NORMAL answer, not an error
// ─────────────────────────────────────────────────────────────────────────────

type hpCase struct {
	Label      string `json:"label"`
	ClassName  string `json:"className"`
	MethodName string `json:"methodName"`
	OK         bool   `json:"ok"`
	Text       string `json:"text"`
	Error      string `json:"error"`
}

type hpFixtures struct {
	DBPath string   `json:"dbPath"`
	Cases  []hpCase `json:"cases"`
}

func loadHarmonyPatchFixtures(t *testing.T) (hpFixtures, *sql.DB) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "harmonypatch_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_harmonypatch_fixtures.mjs", path, err)
	}
	var f hpFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.Cases {
		if !c.OK || c.Text == "" {
			t.Fatalf("case %q did not render in the generator; regenerate the fixtures", c.Label)
		}
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

func TestGenerateHarmonyPatchMatchesTypeScript(t *testing.T) {
	f, db := loadHarmonyPatchFixtures(t)

	compared := 0
	for _, c := range f.Cases {
		got, err := tools.GenerateHarmonyPatch(db, c.ClassName, c.MethodName)
		if err != nil {
			t.Errorf("%s: Go errored: %v", c.Label, err)
			continue
		}
		if got != c.Text {
			t.Errorf("%s: differs\n--- go ---\n%s\n--- ts ---\n%s", c.Label, got, c.Text)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no cases were compared")
	}
	t.Logf("compared %d harmony-patch templates against the TypeScript output, byte for byte", compared)
}

// TestGenerateHarmonyPatchBranchTexts pins the three fixed strings the template can
// carry, so a wording change in either implementation fails loudly here rather than
// silently in every template at once.
func TestGenerateHarmonyPatchBranchTexts(t *testing.T) {
	f, db := loadHarmonyPatchFixtures(t)

	var missingMethod, missingType string
	for _, c := range f.Cases {
		if c.MethodName == "NopeMissing" {
			missingMethod = c.Text
		}
		if c.ClassName == "NotThereAtAll" {
			missingType = c.Text
		}
	}
	if missingType != "Type not found: NotThereAtAll" {
		t.Errorf("missing-type text = %q", missingType)
	}
	if !contains(missingMethod, "Method signature was not found in the AST index. Run bun run setup to rebuild the index first.") {
		t.Errorf("missing-method template does not carry the AST-index sentence:\n%s", missingMethod)
	}
	_ = db
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || indexOf(s, substr) >= 0)
}

func indexOf(s, substr string) int {
	for i := 0; i+len(substr) <= len(s); i++ {
		if s[i:i+len(substr)] == substr {
			return i
		}
	}
	return -1
}
