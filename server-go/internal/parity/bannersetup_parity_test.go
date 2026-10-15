package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/bannersetup"
)

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord-setup parity (the ported subset of src/utils/bannerlord-setup.ts)
//
// The module-private helpers were extracted VERBATIM by the generator and executed, so these are
// the real function's outputs. The corpus pins the rules a reader would "tidy":
//
//   - composeFullVersion does NOT always concatenate: a version already ending in ".<changeset>"
//     comes back unchanged, and an absent version yields nothing at all
//   - getLogicalModuleName returns the FIRST SEGMENT when the path is not under modules/, which is
//     the normal case for a copied XML rather than a degenerate one
//   - the env-name normaliser collapses each RUN of non-alphanumerics to ONE underscore, INCLUDING
//     a leading or trailing run: "!a" -> "_A" and "a!" -> "A_"
//   - getConfiguredGameDir's fallbacks are truthiness-based, so an EMPTY generic variable falls
//     through to the legacy name while a non-empty one stops the search
// ─────────────────────────────────────────────────────────────────────────────

type bsSplitCase struct {
	Values []string `json:"values"`
	Result []string `json:"result"`
}

type bsComposeCase struct {
	GameVersion    *string `json:"gameVersion"`
	BuildChangeset *string `json:"buildChangeset"`
	Result         *string `json:"result"`
}

type bsModuleNameCase struct {
	Path   string  `json:"path"`
	Result *string `json:"result"`
}

type bsEnvNameCase struct {
	ID     string `json:"id"`
	Result string `json:"result"`
}

type bsConfiguredCase struct {
	GameID string            `json:"gameId"`
	Env    map[string]string `json:"env"`
	Note   string            `json:"note"`
	Result *string           `json:"result"`
}

type bsVersionTextCase struct {
	Value  *string `json:"value"`
	Result *string `json:"result"`
}

type bsFixtures struct {
	EULADisclaimer   string              `json:"eulaDisclaimer"`
	SplitCases       []bsSplitCase       `json:"splitCases"`
	ComposeCases     []bsComposeCase     `json:"composeCases"`
	ModuleNameCases  []bsModuleNameCase  `json:"moduleNameCases"`
	EnvNameCases     []bsEnvNameCase     `json:"envNameCases"`
	ConfiguredCases  []bsConfiguredCase  `json:"configuredCases"`
	VersionTextCases []bsVersionTextCase `json:"versionTextCases"`
}

func loadBannerSetupFixtures(t *testing.T) bsFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "bannersetup_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_bannersetup_fixtures.mjs", path, err)
	}
	var f bsFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.SplitCases) == 0 || len(f.ComposeCases) == 0 || len(f.ModuleNameCases) == 0 ||
		len(f.EnvNameCases) == 0 || len(f.ConfiguredCases) == 0 || len(f.VersionTextCases) == 0 {
		t.Fatalf("fixtures look incomplete; refusing to report success")
	}
	return f
}

func TestBannerSetupEULAMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	if bannersetup.EULADisclaimer != f.EULADisclaimer {
		t.Errorf("EULA disclaimer differs\n--- go ---\n%s\n--- ts ---\n%s", bannersetup.EULADisclaimer, f.EULADisclaimer)
	}
}

func TestBannerSetupSplitCLIListMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	for _, c := range f.SplitCases {
		got := bannersetup.SplitCLIList(c.Values)
		if len(got) != len(c.Result) {
			t.Errorf("SplitCLIList(%v) = %v, want %v", c.Values, got, c.Result)
			continue
		}
		for i := range got {
			if got[i] != c.Result[i] {
				t.Errorf("SplitCLIList(%v) = %v, want %v", c.Values, got, c.Result)
				break
			}
		}
	}
}

func TestBannerSetupComposeFullVersionMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	for _, c := range f.ComposeCases {
		got := bannersetup.ComposeFullVersion(deref(c.GameVersion), deref(c.BuildChangeset))
		if !sameStringPtr(nilIfEmpty(got), c.Result) {
			t.Errorf("ComposeFullVersion(%s, %s) = %q, want %s",
				renderStringPtr(c.GameVersion), renderStringPtr(c.BuildChangeset), got, renderStringPtr(c.Result))
		}
	}
}

func TestBannerSetupLogicalModuleNameMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	for _, c := range f.ModuleNameCases {
		got := bannersetup.GetLogicalModuleName(c.Path)
		if !sameStringPtr(nilIfEmpty(got), c.Result) {
			t.Errorf("GetLogicalModuleName(%q) = %q, want %s", c.Path, got, renderStringPtr(c.Result))
		}
	}
}

func TestBannerSetupEnvNameMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	for _, c := range f.EnvNameCases {
		if got := bannersetup.GetPrimaryGameDirEnvName(c.ID); got != c.Result {
			t.Errorf("GetPrimaryGameDirEnvName(%q) = %q, want %q", c.ID, got, c.Result)
		}
	}
}

func TestBannerSetupConfiguredGameDirMatchesTypeScript(t *testing.T) {
	f := loadBannerSetupFixtures(t)
	for _, c := range f.ConfiguredCases {
		env := c.Env
		lookup := func(name string) string { return env[name] }
		got := bannersetup.GetConfiguredGameDir(c.GameID, lookup)
		if !sameStringPtr(nilIfEmpty(got), c.Result) {
			t.Errorf("GetConfiguredGameDir(%q) with %s = %q, want %s",
				c.GameID, c.Note, got, renderStringPtr(c.Result))
		}
	}
}

// TestBannerSetupEnvNameCollapsingRule pins the collapse directly. A port that emitted one
// underscore per CHARACTER, or that dropped a leading/trailing run, fails here while passing a
// corpus made only of clean identifiers.
func TestBannerSetupEnvNameCollapsingRule(t *testing.T) {
	got := bannersetup.GetPrimaryGameDirEnvName("!a")
	if got != "BANNERSAGE__A_GAME_DIR" {
		t.Errorf("a LEADING separator produced %q; a global replace emits one underscore there too", got)
	}
	if trailing := bannersetup.GetPrimaryGameDirEnvName("a!"); trailing != "BANNERSAGE_A__GAME_DIR" {
		t.Errorf("a TRAILING separator produced %q; it must also emit one underscore", trailing)
	}
	if collapsed := bannersetup.GetPrimaryGameDirEnvName("a b  c"); collapsed != "BANNERSAGE_A_B_C_GAME_DIR" {
		t.Errorf("a RUN of separators produced %q; the run collapses to ONE underscore", collapsed)
	}
	if empty := bannersetup.GetPrimaryGameDirEnvName(""); empty != "BANNERSAGE__GAME_DIR" {
		t.Errorf("an empty id produced %q; the empty string yields one underscore", empty)
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
