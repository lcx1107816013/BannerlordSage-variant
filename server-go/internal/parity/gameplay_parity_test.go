package parity_test

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"blore/internal/entityresolver"
	"blore/internal/gameplay"
	"blore/internal/localization"
	"blore/internal/policyid"
	"blore/internal/report"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// Gameplay getters parity: the ten src/tools/get-*.ts tools plus get_entity, and the three
// modules they depend on (localization, entity-resolver, policy-id).
//
// The fixtures were produced by EXECUTING the real TypeScript against a crafted corpus in
// fixtures/gameplay.db, so the expectations are the tool's own output. The database is committed
// and opened here, which is why the whole family can be compared without the 600 MB real index.
//
// ★ WHAT IS *NOT* COVERED, stated rather than implied: the corpus is crafted, so these cases
// prove the PLUMBING — token parsing and resolution, null-vs-empty rendering, JavaScript
// falsiness, reference-label fallbacks, the ordering that picks among duplicate rows, and each
// not-found early return. They do not prove the tools behave on the real corpus, which holds
// values this fixture does not (over a thousand settlements, three thousand items, and hundreds
// of thousands of localization rows). Ordering over many duplicate rows in particular is only
// sampled here.
// ─────────────────────────────────────────────────────────────────────────────

type gpFixture struct {
	FixtureGameID  string          `json:"fixtureGameId"`
	DBPath         string          `json:"dbPath"`
	EntityCases    []gpEntityCase  `json:"entityCases"`
	TokenCases     []gpTokenCase   `json:"tokenCases"`
	ReferenceCases []gpRefCase     `json:"referenceCases"`
	LabelCases     []gpLabelCase   `json:"labelCases"`
	PolicyIDCases  []gpPolicyCase  `json:"policyIdCases"`
	ResolvedCases  []gpResolveCase `json:"resolvedCases"`
}

type gpEntityCase struct {
	Kind  string `json:"kind"`
	ID    string `json:"id"`
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type gpTokenCase struct {
	Input  string          `json:"input"`
	Result *gpTokenPayload `json:"result"`
}

type gpTokenPayload struct {
	ID       string `json:"id"`
	Fallback string `json:"fallback"`
}

type gpRefCase struct {
	Value    *string  `json:"value"`
	Prefixes []string `json:"prefixes"`
	Result   *string  `json:"result"`
}

type gpLabelCase struct {
	Raw    *string `json:"raw"`
	Name   *string `json:"name"`
	Result string  `json:"result"`
}

type gpPolicyCase struct {
	Input  string  `json:"input"`
	Result *string `json:"result"`
}

type gpResolveCase struct {
	Token string `json:"token"`
	// ★ Preferred MUST be deserialized. The fixtures carry a preferred-language list per case,
	// and omitting this field silently sent nil for every case — so the three cases that specify
	// German, Spanish and Japanese were compared against a no-preference call and reported as
	// divergences that were not divergences. A dropped input is indistinguishable from a wrong
	// implementation in the failure output, which is what made this worth a comment.
	Preferred []string         `json:"preferred"`
	Result    string           `json:"result"`
	Details   gpDetailsPayload `json:"details"`
}

type gpDetailsPayload struct {
	StringID      string `json:"stringId"`
	TokenFallback string `json:"tokenFallback"`
	XMLEntries    []struct {
		Language string `json:"language"`
		Text     string `json:"text"`
		FilePath string `json:"filePath"`
	} `json:"xmlEntries"`
}

func loadGameplayFixtures(t *testing.T) (gpFixture, *sql.DB) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "gameplay_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_gameplay_fixtures.mjs", path, err)
	}
	var f gpFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.EntityCases) == 0 || len(f.TokenCases) == 0 {
		t.Fatalf("fixtures look empty (entities=%d tokens=%d); refusing to report success",
			len(f.EntityCases), len(f.TokenCases))
	}

	// ★ Refuse to run against a real game id. The fixtures describe a synthetic corpus; if the
	// path ever pointed at the compiled index the whole comparison would be meaningless — and
	// reading a live index in a test is exactly the mistake that destroyed it once (F19).
	if f.FixtureGameID == "bannerlord" {
		t.Fatalf("fixtures claim to be built against the REAL game id; regenerate them")
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

	// ★ Confirm the corpus is the one the fixtures describe. Without this, regenerating the
	// database with different rows would leave every expectation describing a corpus that no
	// longer exists while the suite still reported PASS.
	var heroes int
	if err := db.QueryRow(`SELECT count(*) FROM bannerlord_heroes`).Scan(&heroes); err != nil {
		t.Fatalf("fixture database has no bannerlord_heroes: %v", err)
	}
	if heroes != 3 {
		t.Fatalf("fixture corpus holds %d heroes, expected 3; regenerate the fixtures", heroes)
	}
	return f, db
}

func TestGameplayEntityCasesMatchTypeScript(t *testing.T) {
	f, db := loadGameplayFixtures(t)

	compared, notFound := 0, 0
	for _, c := range f.EntityCases {
		got, err := gameplay.GetEntity(db, c.Kind, c.ID, nil)
		if err != nil {
			t.Errorf("GetEntity(%q, %q) errored: %v", c.Kind, c.ID, err)
			continue
		}
		if !c.OK {
			t.Errorf("the TypeScript threw for (%s, %s): %s", c.Kind, c.ID, c.Error)
			continue
		}
		if got != c.Text {
			t.Errorf("GetEntity(%q, %q) differs\n--- go ---\n%s\n--- ts ---\n%s",
				c.Kind, c.ID, got, c.Text)
		}
		if len(c.Text) > 0 && c.Text[0] != 'r' && !hasReportType(c.Text) {
			notFound++
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no gameplay entity cases were compared")
	}
	if notFound == 0 {
		t.Fatal("no not-found case was exercised; those early returns are untested")
	}
	t.Logf("compared %d gameplay getter reports (%d were not-found early returns)", compared, notFound)
}

// hasReportType reports whether the text begins a rendered report. The not-found results are bare
// strings, so the two shapes are distinguishable.
func hasReportType(text string) bool {
	const prefix = "report_type: "
	return len(text) >= len(prefix) && text[:len(prefix)] == prefix
}

func TestGameplayTokenParsingMatchesTypeScript(t *testing.T) {
	f, _ := loadGameplayFixtures(t)

	for _, c := range f.TokenCases {
		id, fallback, ok := localization.ParseLocalizationToken(c.Input)
		if (c.Result != nil) != ok {
			t.Errorf("ParseLocalizationToken(%q): ok=%v, TS says %v", c.Input, ok, c.Result != nil)
			continue
		}
		if c.Result == nil {
			continue
		}
		if id != c.Result.ID || fallback != c.Result.Fallback {
			t.Errorf("ParseLocalizationToken(%q) = (%q, %q), TS = (%q, %q)",
				c.Input, id, fallback, c.Result.ID, c.Result.Fallback)
		}
	}
}

func TestGameplayReferenceNormalisationMatchesTypeScript(t *testing.T) {
	f, _ := loadGameplayFixtures(t)

	for _, c := range f.ReferenceCases {
		value := ""
		if c.Value != nil {
			value = *c.Value
		}
		got, ok := entityresolver.NormalizeReference(value, c.Prefixes)
		want := ""
		if c.Result != nil {
			want = *c.Result
		}
		if c.Result == nil {
			if ok {
				t.Errorf("NormalizeReference(%q) reported present, TS says null", value)
			}
			continue
		}
		if !ok || got != want {
			t.Errorf("NormalizeReference(%q, %v) = (%q, %v), TS = %q", value, c.Prefixes, got, ok, want)
		}
	}
}

func TestGameplayReferenceLabelsMatchTypeScript(t *testing.T) {
	f, db := loadGameplayFixtures(t)

	for _, c := range f.LabelCases {
		raw := ""
		if c.Raw != nil {
			raw = *c.Raw
		}
		name := ""
		if c.Name != nil {
			name = *c.Name
		}
		// ★ NO TRUTHINESS JUGGLING HERE ANY MORE. formatReferenceLabel applies `if (displayName)`
		// itself, so an empty name takes the raw-reference branch inside the function. The previous
		// version of this test converted `known && name == ""` into `known = false` at the CALL SITE,
		// which is precisely the shape that hid the defect: every other caller had to remember the
		// same conversion, and the ones that forgot produced `unknown [ref]` instead of `ref`.
		got, err := entityresolver.FormatReferenceLabel(db, raw, name, nil)
		if err != nil {
			t.Errorf("FormatReferenceLabel(%q, %q) errored: %v", raw, name, err)
			continue
		}
		if got != c.Result {
			t.Errorf("FormatReferenceLabel(%q, name=%q) = %q, TS = %q",
				raw, name, got, c.Result)
		}
	}
}

func TestGameplayPolicyIDNormalisationMatchesTypeScript(t *testing.T) {
	f, _ := loadGameplayFixtures(t)

	for _, c := range f.PolicyIDCases {
		got, ok := policyid.Normalize(c.Input)
		if c.Result == nil {
			if ok {
				t.Errorf("Normalize(%q) = %q, TS says null", c.Input, got)
			}
			continue
		}
		if !ok || got != *c.Result {
			t.Errorf("Normalize(%q) = (%q, %v), TS = %q", c.Input, got, ok, *c.Result)
		}
	}
}

func TestGameplayLocalizationResolutionMatchesTypeScript(t *testing.T) {
	f, db := loadGameplayFixtures(t)

	compared := 0
	for _, c := range f.ResolvedCases {
		got, err := localization.ResolveMaybeLocalizedText(db, c.Token, c.Preferred)
		if err != nil {
			t.Errorf("ResolveMaybeLocalizedText(%q) errored: %v", c.Token, err)
			continue
		}
		if got != c.Result {
			t.Errorf("ResolveMaybeLocalizedText(%q) = %q, TS = %q", c.Token, got, c.Result)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no localization cases were compared")
	}

	// The ENTRY ORDER matters as much as the chosen text: it decides which of several rows with
	// the same language wins. Compare the full ordered language sequence for one token.
	var sample *gpResolveCase
	for i := range f.ResolvedCases {
		if f.ResolvedCases[i].Token == "{=item_sword}Sword" {
			sample = &f.ResolvedCases[i]
			break
		}
	}
	if sample == nil {
		t.Fatal("the fixtures no longer contain the item_sword case; ordering is untested")
	}
	details, err := localization.ResolveLocalizationDetails(db, sample.Token, nil)
	if err != nil {
		t.Fatalf("ResolveLocalizationDetails errored: %v", err)
	}
	wantLangs := make([]string, 0, len(sample.Details.XMLEntries))
	for _, e := range sample.Details.XMLEntries {
		wantLangs = append(wantLangs, e.Language)
	}
	gotLangs := make([]string, 0, len(details.XMLEntries))
	for _, e := range details.XMLEntries {
		gotLangs = append(gotLangs, e.Language)
	}
	if !reflect.DeepEqual(gotLangs, wantLangs) {
		t.Errorf("localization entry order differs\ngo  = %v\nts  = %v", gotLangs, wantLangs)
	}
	// ★ THE NON-TOKEN BRANCH IS NOT DEAD CODE, and it needs its own assertion. Every getter passes
	// a token, so the brace-stripping path is only reachable through the public detail resolver —
	// which no other test compared. Mutation testing found this: replacing the brace-stripping with
	// the raw string left the whole suite GREEN because nothing exercised it.
	//
	// `==item_sword{` is the decisive shape: a prefix-only strip would leave it unchanged and find
	// nothing, while the real rule removes braces and equals signs from ANYWHERE and then trims.
	gotDetails, err := localization.ResolveLocalizationDetails(db, "==item_sword{", nil)
	if err != nil {
		t.Fatalf("ResolveLocalizationDetails errored: %v", err)
	}
	if gotDetails.StringID != "item_sword" {
		t.Errorf("non-token id normalisation = %q, want item_sword (braces/equals stripped anywhere)",
			gotDetails.StringID)
	}
	if len(gotDetails.XMLEntries) == 0 {
		t.Errorf("a brace-wrapped id found no entries; the id was probably not normalised")
	}
	// And it must NOT be treated as a token, so no inline fallback and no parenthesised suffix.
	plain, err := localization.ResolveMaybeLocalizedText(db, "==item_sword{", nil)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "==item_sword{" {
		t.Errorf("a non-token input must be returned unchanged, got %q", plain)
	}

	t.Logf("compared %d localization resolutions; entry order for item_sword: %v", compared, gotLangs)
}

// TestGameplayDefaultPreferredOrder pins the built-in language preference, which decides which
// translation wins when the caller expresses no preference. It is asserted directly because it is
// a policy of the tool rather than a consequence of the data.
func TestGameplayDefaultPreferredOrder(t *testing.T) {
	_, db := loadGameplayFixtures(t)

	// CNs must win over the English source row and over every other shipped language, because the
	// built-in order is chinese_simplified, chinese_traditional, english.
	got, err := localization.ResolveMaybeLocalizedText(db, "{=item_sword}Sword", nil)
	if err != nil {
		t.Fatal(err)
	}
	const want = "剑 ({=item_sword})"
	if got != want {
		t.Errorf("default preference = %q, want %q (chinese_simplified must rank first)", got, want)
	}

	// And an explicit preference must override it.
	got, err = localization.ResolveMaybeLocalizedText(db, "{=item_sword}Sword", []string{"DE"})
	if err != nil {
		t.Fatal(err)
	}
	if got != "Schwert ({=item_sword})" {
		t.Errorf("explicit DE preference = %q, want the German text", got)
	}

	// An unknown preference falls through to the built-in order rather than picking nothing.
	got, err = localization.ResolveMaybeLocalizedText(db, "{=item_sword}Sword", []string{"zz-unknown"})
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Errorf("unknown preference = %q, want the built-in default %q", got, want)
	}
}

// TestGameplayRenderShapeIsTheReportFormat guards the one convention every getter shares: a
// not-found result is a BARE STRING, not a report. A port that rendered an empty report instead
// would look tidier and would break every caller that checks the text.
func TestGameplayRenderShapeIsTheReportFormat(t *testing.T) {
	_, db := loadGameplayFixtures(t)

	cases := []struct{ kind, id, want string }{
		{"hero", "nope", "Hero not found: nope"},
		{"skill", "nope", "Skill data not found: nope"},
		{"culture", "nope", "Culture not found: nope"},
		{"clan", "nope", "Clan or faction not found: nope"},
		{"kingdom", "nope", "Kingdom not found: nope"},
		{"perk", "nope", "Perk not found: nope"},
		{"item", "nope", "Item or crafting piece not found: nope"},
		{"settlement", "nope", "Settlement not found: nope"},
		{"troop", "nope", "Troop not found: nope"},
	}
	for _, c := range cases {
		got, err := gameplay.GetEntity(db, c.kind, c.id, nil)
		if err != nil {
			t.Errorf("%s: unexpected error: %v", c.kind, err)
			continue
		}
		if got != c.want {
			t.Errorf("%s not-found text = %q, want %q", c.kind, got, c.want)
		}
	}

	// The policy tool's not-found text uses the ORIGINAL query, not the normalised id.
	got, err := gameplay.GetEntity(db, "policy", "Policy.nope", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != "Policy not found: Policy.nope" {
		t.Errorf("policy not-found text = %q, want the original query echoed", got)
	}

	// An unknown kind is an error rather than an empty success.
	if _, err := gameplay.GetEntity(db, "not_a_kind", "x", nil); err == nil {
		t.Error("an unknown entity kind must be an error, not an empty result")
	}
}

// TestGameplayNullIsNotZero pins the distinction the whole family depends on, using numbers that
// a naive port collapses: NULL must render as "unknown" while a real 0 renders as "0".
func TestGameplayNullIsNotZero(t *testing.T) {
	_, db := loadGameplayFixtures(t)

	// town_a has numeric fields set; quiet has nulls. Compare the two renderings directly.
	town, err := gameplay.GetEntity(db, "settlement", "town_a", nil)
	if err != nil {
		t.Fatal(err)
	}
	if !containsLine(town, "prosperity_or_hearth: 5000") {
		t.Errorf("expected the real value to render:\n%s", town)
	}

	// odd_a has NULL prosperity, positionX and positionY.
	odd, err := gameplay.GetEntity(db, "settlement", "odd_a", nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"prosperity_or_hearth: unknown",
		"map_pos_x: unknown",
		"map_pos_y: unknown",
		"location_node_count: 0",
		"building_node_count: 0",
	} {
		if !containsLine(odd, want) {
			t.Errorf("expected %q in:\n%s", want, odd)
		}
	}
	// And a real zero must NOT become unknown.
	if containsLine(odd, "location_node_count: unknown") {
		t.Errorf("a real 0 was rendered as unknown:\n%s", odd)
	}
}

func containsLine(text, line string) bool {
	for _, l := range splitLinesForTest(text) {
		if l == line {
			return true
		}
	}
	return false
}

func splitLinesForTest(text string) []string {
	var out []string
	start := 0
	for i := 0; i < len(text); i++ {
		if text[i] == '\n' {
			out = append(out, text[start:i])
			start = i + 1
		}
	}
	return append(out, text[start:])
}

// TestReportItoaIsDecimal keeps the shared header formatter honest: the report format uses plain
// decimal indices, so anything locale- or separator-aware here would change every block header.
func TestReportItoaIsDecimal(t *testing.T) {
	for _, tc := range []struct {
		in   int
		want string
	}{{0, "0"}, {1, "1"}, {9, "9"}, {10, "10"}, {120, "120"}} {
		if got := report.Itoa(tc.in); got != tc.want {
			t.Errorf("Itoa(%d) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
