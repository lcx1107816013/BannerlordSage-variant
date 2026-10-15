package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/apidocs"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord-api-docs parity (src/utils/bannerlord-api-docs.ts)
//
// The expected values come from EXECUTING the real module against two committed fixture databases:
// one populated with 1.2.9 / 1.9.0 / 1.10.0 / 2.0.0 (chosen so a TEXTUAL sort disagrees with a
// numeric one), and an empty one for the "nothing indexed" branch.
//
// The corpus pins what a careful reader would "fix":
//
//   - normalizeApiVersion is NOT a validator: fewer than three parts pass through UNCHANGED, so
//     "a.b.c" comes back as "a.b.c" and is then compared as a version
//   - compareApiVersions returns the numeric DELTA, not a normalised sign
//   - parseVersionParts uses parseInt, so "1a" is 1 (not 0), "1e3" is 1 (not 1000) and "0x10" is 0
//     (not 16)
//   - only ONE leading "v" is stripped: "vV1.2.9" -> "1.2.9"? no — it becomes "V1.2.9"
//   - installed version falls back to fullVersion BEFORE normalising, so a present-but-unparseable
//     gameVersion does not fall through
//   - authority/usage are derived from the exact-match condition, not from the selection
// ─────────────────────────────────────────────────────────────────────────────

type adNormalizeCase struct {
	Value  *string `json:"value"`
	Result *string `json:"result"`
}

type adCompareCase struct {
	Left   string `json:"left"`
	Right  string `json:"right"`
	Result int    `json:"result"`
}

type adResolution struct {
	InstalledGameVersion *string  `json:"installedGameVersion"`
	InstalledFullVersion *string  `json:"installedFullVersion"`
	RequestedAPIVersion  *string  `json:"requestedApiVersion"`
	SelectedAPIVersion   *string  `json:"selectedApiVersion"`
	ExactMatch           bool     `json:"exactMatch"`
	Authority            string   `json:"authority"`
	Usage                string   `json:"usage"`
	Warning              *string  `json:"warning"`
	AvailableVersions    []string `json:"availableVersions"`
}

type adResolutionCase struct {
	Label       string       `json:"label"`
	GameVersion *string      `json:"gameVersion"`
	FullVersion *string      `json:"fullVersion"`
	Requested   *string      `json:"requested"`
	Resolution  adResolution `json:"resolution"`
}

type adFixtures struct {
	DBPath          string             `json:"dbPath"`
	EmptyDBPath     string             `json:"emptyDbPath"`
	IndexedVersions []string           `json:"indexedVersions"`
	Sections        []string           `json:"sections"`
	NormalizeCases  []adNormalizeCase  `json:"normalizeCases"`
	CompareCases    []adCompareCase    `json:"compareCases"`
	ResolutionCases []adResolutionCase `json:"resolutionCases"`
	EmptyCases      []adResolutionCase `json:"emptyCases"`
}

func loadAPIDocsFixtures(t *testing.T) adFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "apidocs_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_apidocs_fixtures.mjs", path, err)
	}
	var f adFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.NormalizeCases) == 0 || len(f.CompareCases) == 0 || len(f.ResolutionCases) == 0 || len(f.EmptyCases) == 0 {
		t.Fatalf("fixtures look incomplete; refusing to report success")
	}
	return f
}

func openFixtureDB(t *testing.T, rel string) *sql.DB {
	t.Helper()
	dbFile := filepath.Join("..", "..", rel)
	if _, err := os.Stat(dbFile); err != nil {
		t.Fatalf("fixture database missing (%s): %v\nregenerate the fixtures", dbFile, err)
	}
	db, err := sql.Open("sqlite", dbFile)
	if err != nil {
		t.Fatalf("cannot open fixture database: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return db
}

func TestAPIDocsNormalizeMatchesTypeScript(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	for _, c := range f.NormalizeCases {
		got := apidocs.NormalizeAPIVersion(deref(c.Value))
		if !sameStringPtr(nilIfEmpty(got), c.Result) {
			t.Errorf("NormalizeAPIVersion(%s) = %q, want %s",
				renderStringPtr(c.Value), got, renderStringPtr(c.Result))
		}
	}
	t.Logf("compared %d normalizeApiVersion cases", len(f.NormalizeCases))
}

func TestAPIDocsCompareMatchesTypeScript(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	for _, c := range f.CompareCases {
		if got := apidocs.CompareAPIVersions(c.Left, c.Right); got != c.Result {
			t.Errorf("CompareAPIVersions(%q, %q) = %d, want %d", c.Left, c.Right, got, c.Result)
		}
	}
	t.Logf("compared %d compareApiVersions cases", len(f.CompareCases))
}

func TestAPIDocsSectionsMatchTypeScript(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	if len(apidocs.Sections) != len(f.Sections) {
		t.Fatalf("Sections has %d entries, want %d", len(apidocs.Sections), len(f.Sections))
	}
	for i := range apidocs.Sections {
		if apidocs.Sections[i] != f.Sections[i] {
			t.Errorf("Sections[%d] = %q, want %q", i, apidocs.Sections[i], f.Sections[i])
		}
	}
	// IsSection must reject a value that is merely similar, and accept every listed one.
	for _, s := range f.Sections {
		if !apidocs.IsSection(s) {
			t.Errorf("IsSection(%q) = false for a listed section", s)
		}
	}
	for _, s := range []string{"", "Classes", "classes ", "method", "function"} {
		if apidocs.IsSection(s) {
			t.Errorf("IsSection(%q) = true; the test is a case-sensitive exact match", s)
		}
	}
}

// TestAPIDocsIndexedVersionsAreNumeric checks the ordering against a fixture whose insertion order
// makes a textual sort visibly wrong: as text, "1.10.0" sorts BEFORE "1.9.0".
func TestAPIDocsIndexedVersionsAreNumeric(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	db := openFixtureDB(t, f.DBPath)

	got, err := apidocs.ReadIndexedAPIVersions(db)
	if err != nil {
		t.Fatalf("ReadIndexedAPIVersions: %v", err)
	}
	if len(got) != len(f.IndexedVersions) {
		t.Fatalf("got %v, want %v", got, f.IndexedVersions)
	}
	for i := range got {
		if got[i] != f.IndexedVersions[i] {
			t.Fatalf("version %d = %q, want %q (full: got %v, want %v)",
				i, got[i], f.IndexedVersions[i], got, f.IndexedVersions)
		}
	}
	if got[0] != "2.0.0" {
		t.Errorf("newest first expected; got %q first", got[0])
	}
}

func TestAPIDocsResolutionMatchesTypeScript(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	db := openFixtureDB(t, f.DBPath)

	check := func(t *testing.T, c adResolutionCase) {
		t.Helper()
		state := apidocs.GameState{GameVersion: deref(c.GameVersion), FullVersion: deref(c.FullVersion)}
		got, err := apidocs.ResolveVersion(db, state, deref(c.Requested))
		if err != nil {
			t.Errorf("%s: ResolveVersion: %v", c.Label, err)
			return
		}
		want := c.Resolution

		if !sameStringPtr(nilIfEmpty(got.InstalledGameVersion), want.InstalledGameVersion) {
			t.Errorf("%s: InstalledGameVersion = %q, want %s", c.Label, got.InstalledGameVersion, renderStringPtr(want.InstalledGameVersion))
		}
		if !sameStringPtr(nilIfEmpty(got.InstalledFullVersion), want.InstalledFullVersion) {
			t.Errorf("%s: InstalledFullVersion = %q, want %s", c.Label, got.InstalledFullVersion, renderStringPtr(want.InstalledFullVersion))
		}
		if !sameStringPtr(nilIfEmpty(got.RequestedAPIVersion), want.RequestedAPIVersion) {
			t.Errorf("%s: RequestedAPIVersion = %q, want %s", c.Label, got.RequestedAPIVersion, renderStringPtr(want.RequestedAPIVersion))
		}
		if got.HasSelection != (want.SelectedAPIVersion != nil) {
			t.Errorf("%s: HasSelection = %v, want %v", c.Label, got.HasSelection, want.SelectedAPIVersion != nil)
		}
		if !sameStringPtr(nilIfEmpty(got.SelectedAPIVersion), want.SelectedAPIVersion) {
			t.Errorf("%s: SelectedAPIVersion = %q, want %s", c.Label, got.SelectedAPIVersion, renderStringPtr(want.SelectedAPIVersion))
		}
		if got.ExactMatch != want.ExactMatch {
			t.Errorf("%s: ExactMatch = %v, want %v", c.Label, got.ExactMatch, want.ExactMatch)
		}
		if got.Authority != want.Authority {
			t.Errorf("%s: Authority = %q, want %q", c.Label, got.Authority, want.Authority)
		}
		if got.Usage != want.Usage {
			t.Errorf("%s: Usage = %q, want %q", c.Label, got.Usage, want.Usage)
		}
		if got.HasWarning != (want.Warning != nil) {
			t.Errorf("%s: HasWarning = %v, want %v", c.Label, got.HasWarning, want.Warning != nil)
		}
		if !sameStringPtr(nilIfEmpty(got.Warning), want.Warning) {
			t.Errorf("%s: Warning = %q, want %s", c.Label, got.Warning, renderStringPtr(want.Warning))
		}
		if len(got.AvailableVersions) != len(want.AvailableVersions) {
			t.Errorf("%s: AvailableVersions = %v, want %v", c.Label, got.AvailableVersions, want.AvailableVersions)
		}
	}

	for _, c := range f.ResolutionCases {
		check(t, c)
	}
	t.Logf("compared %d version resolutions against the TypeScript", len(f.ResolutionCases))
}

// TestAPIDocsEmptyIndex pins the branch the populated database cannot reach: nothing indexed means
// no selection, a warning naming the indexing command, and the local-source authority.
func TestAPIDocsEmptyIndex(t *testing.T) {
	f := loadAPIDocsFixtures(t)
	empty := openFixtureDB(t, f.EmptyDBPath)

	got, err := apidocs.ResolveVersion(empty, apidocs.GameState{}, "")
	if err != nil {
		t.Fatalf("ResolveVersion: %v", err)
	}
	if got.HasSelection {
		t.Errorf("an empty index must produce NO selection, got %q", got.SelectedAPIVersion)
	}
	if got.Authority != "local_decompiled_source" || got.Usage != "historical_reference_only" {
		t.Errorf("authority/usage = %q/%q, want local_decompiled_source / historical_reference_only", got.Authority, got.Usage)
	}
	if !got.HasWarning {
		t.Error("an empty index must carry a warning")
	}
	if len(got.AvailableVersions) != 0 {
		t.Errorf("AvailableVersions = %v, want empty", got.AvailableVersions)
	}
}

// TestAPIDocsParseVersionPartsIsParseInt pins the numeric rule directly, because it is the one most
// likely to be "tidied" into strconv.Atoi with a zero fallback — which agrees on pure digits and
// disagrees on everything else.
func TestAPIDocsParseVersionPartsIsParseInt(t *testing.T) {
	cases := []struct {
		in   string
		want []int
	}{
		{"1.2.9", []int{1, 2, 9}},
		{"01", []int{1}},   // leading zeros are not octal
		{"1a", []int{1}},   // a trailing suffix is silently dropped
		{"9x9", []int{9}},  // ditto
		{"1e3", []int{1}},  // NOT 1000
		{"0x10", []int{0}}, // NOT 16: base 10 refuses the prefix
		{"abc", []int{0}},  // NaN repaired to 0
		{"", []int{0}},     // NaN repaired to 0
		{" 1", []int{1}},   // parseInt skips leading whitespace itself
		{"-1", []int{-1}},  // a sign is honoured
		{"+2", []int{2}},
		{"v1.2", []int{1, 2}}, // the v is stripped first
		{"1.2.9.0", []int{1, 2, 9, 0}},
	}
	for _, c := range cases {
		got := apidocs.ParseVersionParts(c.in)
		if len(got) != len(c.want) {
			t.Errorf("ParseVersionParts(%q) = %v, want %v", c.in, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("ParseVersionParts(%q) = %v, want %v", c.in, got, c.want)
				break
			}
		}
	}
}

// TestAPIDocsStripsExactlyOneVPrefix pins the single-character strip. Two chained TrimPrefix calls
// would remove a second "v", which only shows up on input like "vV1.2.9".
func TestAPIDocsStripsExactlyOneVPrefix(t *testing.T) {
	if got := apidocs.NormalizeAPIVersion("vV1.2.9"); got != "V1.2.9" {
		t.Errorf("NormalizeAPIVersion(\"vV1.2.9\") = %q, want %q (exactly ONE leading v is stripped)", got, "V1.2.9")
	}
	if got := apidocs.NormalizeAPIVersion("vv1.2.9"); got != "v1.2.9" {
		t.Errorf("NormalizeAPIVersion(\"vv1.2.9\") = %q, want %q", got, "v1.2.9")
	}
	if got := apidocs.NormalizeAPIVersion("V1.2.9"); got != "1.2.9" {
		t.Errorf("NormalizeAPIVersion(\"V1.2.9\") = %q, want %q", got, "1.2.9")
	}
}

// TestAPIDocsNonVersionPassesThrough pins that normalizeApiVersion is not a validator: a value with
// fewer than three parts comes back unchanged, whatever it contains.
func TestAPIDocsNonVersionPassesThrough(t *testing.T) {
	if got := apidocs.NormalizeAPIVersion("a.b.c"); got != "a.b.c" {
		t.Errorf("NormalizeAPIVersion(\"a.b.c\") = %q; fewer than three parts pass through unchanged", got)
	}
	if got := apidocs.NormalizeAPIVersion("1.2"); got != "1.2" {
		t.Errorf("NormalizeAPIVersion(\"1.2\") = %q, want \"1.2\"", got)
	}
	if got := apidocs.NormalizeAPIVersion("1.2.9.4.5"); got != "1.2.9" {
		t.Errorf("NormalizeAPIVersion(\"1.2.9.4.5\") = %q, want \"1.2.9\" (only the first three survive)", got)
	}
	if got := apidocs.NormalizeAPIVersion("1..2"); got != "1.2" {
		t.Errorf("NormalizeAPIVersion(\"1..2\") = %q, want \"1.2\" (empty parts are dropped before the length test)", got)
	}
}
