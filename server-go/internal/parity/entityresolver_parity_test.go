package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/entityresolver"
	"blore/internal/policyid"

	_ "modernc.org/sqlite"
)

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord-entity-resolver parity (src/utils/bannerlord-entity-resolver.ts and
// src/utils/bannerlord-policy-id.ts)
//
// The expected values come from EXECUTING the real TypeScript against a fixture database whose six
// schemas are copied from the real index and whose rows are crafted to separate the ORDER BY rules:
//
//   - a culture with two rows where the name-count clause and the description clause DISAGREE about
//     which row should win, so a reordered ORDER BY is visible
//   - a troop whose two rows are identical except for filePath, isolating the tiebreaker
//   - a clan with noble / minor-faction / plain rows under one id, where isNoble must win despite
//     sorting last by filePath
//   - a policy reachable only through the alias, with the misspelt spelling deliberately ABSENT from
//     the corpus so the alias is actually doing the work
// ─────────────────────────────────────────────────────────────────────────────

type erPureCase struct {
	Kind     string   `json:"kind"`
	Input    *string  `json:"input"`
	Prefixes []string `json:"prefixes"`
	Result   *string  `json:"result"`
}

type erLookupCase struct {
	Fn        string          `json:"fn"`
	Reference *string         `json:"reference"`
	Result    json.RawMessage `json:"result"`
	Error     *string         `json:"error"`
}

type erLabelCase struct {
	Raw         *string `json:"raw"`
	DisplayName *string `json:"displayName"`
	Result      *string `json:"result"`
	Error       *string `json:"error"`
}

type erFixtures struct {
	DBPath      string         `json:"dbPath"`
	PureCases   []erPureCase   `json:"pureCases"`
	LookupCases []erLookupCase `json:"lookupCases"`
	LabelCases  []erLabelCase  `json:"labelCases"`
}

func loadEntityResolverFixtures(t *testing.T) erFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "entityresolver_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_entityresolver_fixtures.mjs", path, err)
	}
	var f erFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.PureCases) == 0 || len(f.LookupCases) == 0 || len(f.LabelCases) == 0 {
		t.Fatal("fixtures look incomplete; refusing to report success")
	}
	// A recorded throw in a lookup would mean the TypeScript has an error path this port does not
	// model, so it is surfaced rather than skipped.
	for _, c := range f.LookupCases {
		if c.Error != nil {
			t.Fatalf("fixture %s(%s) recorded a THROW (%s); the port has no matching error branch",
				c.Fn, deref(c.Reference), *c.Error)
		}
	}
	for _, c := range f.LabelCases {
		if c.Error != nil {
			t.Fatalf("fixture formatReferenceLabel(%s, %s) recorded a THROW (%s)",
				deref(c.Raw), deref(c.DisplayName), *c.Error)
		}
	}
	return f
}

func TestEntityResolverNormalizeReference(t *testing.T) {
	f := loadEntityResolverFixtures(t)
	compared := 0
	for _, c := range f.PureCases {
		if c.Kind != "normalizeReference" {
			continue
		}
		got, ok := entityresolver.NormalizeReference(deref(c.Input), c.Prefixes)
		want := c.Result
		if !ok {
			if want != nil {
				t.Errorf("NormalizeReference(%q, %v) reported absent, TypeScript returned %q",
					deref(c.Input), c.Prefixes, *want)
			}
			continue
		}
		if want == nil {
			t.Errorf("NormalizeReference(%q, %v) = %q, but the TypeScript returned null",
				deref(c.Input), c.Prefixes, got)
			continue
		}
		if got != *want {
			t.Errorf("NormalizeReference(%q, %v) = %q, want %q", deref(c.Input), c.Prefixes, got, *want)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no normalizeReference cases were compared")
	}
	t.Logf("compared %d normalizeReference cases", compared)
}

// TestEntityResolverPrefixOrderMatters pins that the FIRST matching prefix is applied and the
// remainder is left alone — a "strip every prefix" implementation would return "vlandia" here.
func TestEntityResolverPrefixOrderMatters(t *testing.T) {
	got, ok := entityresolver.NormalizeReference("Faction.Kingdom.vlandia", []string{"Faction.", "Kingdom."})
	if !ok || got != "Kingdom.vlandia" {
		t.Errorf("NormalizeReference(\"Faction.Kingdom.vlandia\") = %q (ok=%v), want \"Kingdom.vlandia\" "+
			"(only the FIRST matching prefix is stripped)", got, ok)
	}
	// And the order of the list decides which one that is.
	got, _ = entityresolver.NormalizeReference("Faction.Kingdom.vlandia", []string{"Kingdom.", "Faction."})
	if got != "Kingdom.vlandia" {
		t.Errorf("with the list reordered it must still strip Faction. (Kingdom. does not match the "+
			"start): got %q", got)
	}
	got, _ = entityresolver.NormalizeReference("Kingdom.Faction.vlandia", []string{"Faction.", "Kingdom."})
	if got != "Faction.vlandia" {
		t.Errorf("NormalizeReference(\"Kingdom.Faction.vlandia\") = %q, want \"Faction.vlandia\"", got)
	}
}

func TestEntityResolverPolicyID(t *testing.T) {
	f := loadEntityResolverFixtures(t)
	compared := 0
	for _, c := range f.PureCases {
		if c.Kind != "policyId" {
			continue
		}
		got, ok := policyid.Normalize(deref(c.Input))
		want := c.Result
		if !ok {
			if want != nil {
				t.Errorf("policyid.Normalize(%q) reported absent, TypeScript returned %q", deref(c.Input), *want)
			}
			continue
		}
		if want == nil {
			t.Errorf("policyid.Normalize(%q) = %q, but the TypeScript returned null", deref(c.Input), got)
			continue
		}
		if got != *want {
			t.Errorf("policyid.Normalize(%q) = %q, want %q", deref(c.Input), got, *want)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no policy-id cases were compared")
	}
	t.Logf("compared %d policy-id cases", compared)
}

func TestEntityResolverLookups(t *testing.T) {
	f := loadEntityResolverFixtures(t)
	db := openFixtureDB(t, f.DBPath)

	compared := 0
	for _, c := range f.LookupCases {
		// Each case is dispatched by the name the generator recorded, so a case can never be
		// silently dropped by a switch that forgot one.
		switch c.Fn {
		case "lookupCultureName":
			name, ok, err := entityresolver.LookupCultureName(db, deref(c.Reference))
			checkScalarLookup(t, c, name, ok, err)
		case "lookupHeroName":
			name, ok, err := entityresolver.LookupHeroName(db, deref(c.Reference))
			checkScalarLookup(t, c, name, ok, err)
		case "lookupPolicyName":
			name, ok, err := entityresolver.LookupPolicyName(db, deref(c.Reference))
			checkScalarLookup(t, c, name, ok, err)
		case "lookupClanInfo":
			info, err := entityresolver.LookupClanInfo(db, deref(c.Reference))
			if err != nil {
				t.Errorf("LookupClanInfo(%s): %v", deref(c.Reference), err)
				continue
			}
			checkClanInfo(t, c, info)
		case "lookupKingdomInfo":
			info, err := entityresolver.LookupKingdomInfo(db, deref(c.Reference))
			if err != nil {
				t.Errorf("LookupKingdomInfo(%s): %v", deref(c.Reference), err)
				continue
			}
			checkKingdomInfo(t, c, info)
		case "lookupSettlementInfo":
			info, err := entityresolver.LookupSettlementInfo(db, deref(c.Reference))
			if err != nil {
				t.Errorf("LookupSettlementInfo(%s): %v", deref(c.Reference), err)
				continue
			}
			checkSettlementInfo(t, c, info)
		default:
			t.Errorf("fixture names an unknown lookup %q; the port has no such function", c.Fn)
		}
		compared++
	}
	t.Logf("compared %d lookup cases", compared)
}

func checkScalarLookup(t *testing.T, c erLookupCase, got string, ok bool, err error) {
	t.Helper()
	if err != nil {
		t.Errorf("%s(%s): %v", c.Fn, deref(c.Reference), err)
		return
	}
	// A JSON null result means the TypeScript returned null.
	if string(c.Result) == "null" {
		if ok {
			t.Errorf("%s(%s) = %q, but the TypeScript returned null", c.Fn, deref(c.Reference), got)
		}
		return
	}
	var want string
	if err := json.Unmarshal(c.Result, &want); err != nil {
		t.Errorf("%s(%s): fixture result is not a string: %s", c.Fn, deref(c.Reference), c.Result)
		return
	}
	if !ok {
		t.Errorf("%s(%s) reported absent, want %q", c.Fn, deref(c.Reference), want)
		return
	}
	if got != want {
		t.Errorf("%s(%s) = %q, want %q", c.Fn, deref(c.Reference), got, want)
	}
}

func checkClanInfo(t *testing.T, c erLookupCase, got *entityresolver.ClanInfo) {
	t.Helper()
	if string(c.Result) == "null" {
		if got != nil {
			t.Errorf("%s(%s) = %+v, but the TypeScript returned null", c.Fn, deref(c.Reference), got)
		}
		return
	}
	var want struct {
		ClanID         string  `json:"clanId"`
		Name           *string `json:"name"`
		SuperFaction   *string `json:"superFaction"`
		IsNoble        int     `json:"isNoble"`
		IsMinorFaction int     `json:"isMinorFaction"`
		IsBandit       int     `json:"isBandit"`
		IsMercenary    int     `json:"isMercenary"`
	}
	if err := json.Unmarshal(c.Result, &want); err != nil {
		t.Errorf("%s(%s): fixture result undecodable: %s", c.Fn, deref(c.Reference), c.Result)
		return
	}
	if got == nil {
		t.Errorf("%s(%s) = null, want %+v", c.Fn, deref(c.Reference), want)
		return
	}
	if got.ClanID != want.ClanID || got.Name != deref(want.Name) || got.SuperFaction != deref(want.SuperFaction) ||
		got.IsNoble != want.IsNoble || got.IsMinorFaction != want.IsMinorFaction ||
		got.IsBandit != want.IsBandit || got.IsMercenary != want.IsMercenary {
		t.Errorf("%s(%s) = %+v, want clanId=%s name=%v superFaction=%v noble=%d minor=%d bandit=%d mercenary=%d",
			c.Fn, deref(c.Reference), got, want.ClanID, *want.Name, want.SuperFaction,
			want.IsNoble, want.IsMinorFaction, want.IsBandit, want.IsMercenary)
	}
}

func checkKingdomInfo(t *testing.T, c erLookupCase, got *entityresolver.KingdomInfo) {
	t.Helper()
	if string(c.Result) == "null" {
		if got != nil {
			t.Errorf("%s(%s) = %+v, but the TypeScript returned null", c.Fn, deref(c.Reference), got)
		}
		return
	}
	var want struct {
		KingdomID string  `json:"kingdomId"`
		Name      *string `json:"name"`
	}
	if err := json.Unmarshal(c.Result, &want); err != nil {
		t.Errorf("%s(%s): fixture result undecodable: %s", c.Fn, deref(c.Reference), c.Result)
		return
	}
	if got == nil {
		t.Errorf("%s(%s) = null, want kingdomId=%s", c.Fn, deref(c.Reference), want.KingdomID)
		return
	}
	if got.KingdomID != want.KingdomID || got.Name != deref(want.Name) {
		t.Errorf("%s(%s) = %+v, want kingdomId=%s name=%v", c.Fn, deref(c.Reference), got, want.KingdomID, *want.Name)
	}
}

func checkSettlementInfo(t *testing.T, c erLookupCase, got *entityresolver.SettlementInfo) {
	t.Helper()
	if string(c.Result) == "null" {
		if got != nil {
			t.Errorf("%s(%s) = %+v, but the TypeScript returned null", c.Fn, deref(c.Reference), got)
		}
		return
	}
	var want struct {
		SettlementID    string  `json:"settlementId"`
		Name            *string `json:"name"`
		Owner           *string `json:"owner"`
		BoundSettlement *string `json:"boundSettlement"`
		SettlementType  *string `json:"settlementType"`
	}
	if err := json.Unmarshal(c.Result, &want); err != nil {
		t.Errorf("%s(%s): fixture result undecodable: %s", c.Fn, deref(c.Reference), c.Result)
		return
	}
	if got == nil {
		t.Errorf("%s(%s) = null, want settlementId=%s", c.Fn, deref(c.Reference), want.SettlementID)
		return
	}
	if got.SettlementID != want.SettlementID || got.Name != deref(want.Name) || got.Owner != deref(want.Owner) ||
		got.BoundSettlement != deref(want.BoundSettlement) || got.SettlementType != deref(want.SettlementType) {
		t.Errorf("%s(%s) = %+v, want settlementId=%s name=%v owner=%v bound=%v type=%v",
			c.Fn, deref(c.Reference), got, want.SettlementID, *want.Name, want.Owner, want.BoundSettlement, want.SettlementType)
	}
}

func TestEntityResolverFormatReferenceLabel(t *testing.T) {
	f := loadEntityResolverFixtures(t)
	db := openFixtureDB(t, f.DBPath)

	compared := 0
	for _, c := range f.LabelCases {
		// ★ NO `known` FLAG IS PASSED. The TypeScript tests the display name's TRUTHINESS, so the
		// port does too — that is what the differential established when a row with an empty name
		// made the two disagree.
		got, err := entityresolver.FormatReferenceLabel(db, deref(c.Raw), deref(c.DisplayName), nil)
		if err != nil {
			t.Errorf("FormatReferenceLabel(%s, %s): %v", deref(c.Raw), deref(c.DisplayName), err)
			continue
		}
		if c.Result == nil {
			t.Errorf("FormatReferenceLabel(%s, %s) = %q, but the fixture has no result",
				deref(c.Raw), deref(c.DisplayName), got)
			continue
		}
		if got != *c.Result {
			t.Errorf("FormatReferenceLabel(%s, %s) = %q, want %q",
				deref(c.Raw), deref(c.DisplayName), got, *c.Result)
		}
		compared++
	}
	t.Logf("compared %d formatReferenceLabel cases", compared)
}

// TestEntityResolverFixtureDatabaseIsTheIntendedOne guards against reading a stale fixture: the
// culture case only means something if the two rows are actually there.
func TestEntityResolverFixtureDatabaseIsTheIntendedOne(t *testing.T) {
	f := loadEntityResolverFixtures(t)
	db := openFixtureDB(t, f.DBPath)

	var cultureRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_cultures WHERE cultureId = 'vlandia'`).Scan(&cultureRows); err != nil {
		t.Fatal(err)
	}
	if cultureRows != 2 {
		t.Fatalf("the culture corpus has %d rows for vlandia; the ORDER BY case needs 2", cultureRows)
	}
	var clanRows int
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_clans WHERE clanId = 'clan_x'`).Scan(&clanRows); err != nil {
		t.Fatal(err)
	}
	if clanRows != 3 {
		t.Fatalf("the clan corpus has %d rows for clan_x; the ranking case needs 3", clanRows)
	}
	// The alias case is vacuous if the misspelt id is present, so its absence is asserted here too.
	var misspelt int
	if err := db.QueryRow(`SELECT COUNT(*) FROM bannerlord_policies WHERE policyId = 'policy_land_grands_for_veteran'`).Scan(&misspelt); err != nil {
		t.Fatal(err)
	}
	if misspelt != 0 {
		t.Fatal("the corpus stores the misspelt policy id, which makes the alias case prove nothing")
	}
}
