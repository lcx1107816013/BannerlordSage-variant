// Package bannersetup ports the pure, testable core of src/utils/bannerlord-setup.ts.
//
// ★ WHAT IS PORTED, AND WHY THE REST IS NOT.
//
// This file contains the parts whose behaviour is fully determined by their arguments and can
// therefore be differentially tested against the TypeScript: the setup-state shape, the version
// composition, the CLI list splitter, the module-name derivation from a relative path, the game-dir
// environment-name derivation, and the two small readers (SubModule Version, package_info
// changeset).
//
// Deliberately NOT ported here, each for a stated reason rather than for convenience:
//
//   - ensureGameDir / detectBannerlordGameDir: installation DISCOVERY. The Go side takes the game
//     directory as an input, as the tools layer already does.
//   - ensureIlspyExecutable / decompileDll / installIlspyCmd: PROCESS SPAWNING. Those belong with
//     whatever runs the indexer, and nothing in the ported tool bodies calls them.
//   - copyGameXmls: a large stateful file-copy with its own incremental rules. It is the one piece
//     here that would benefit from being its own reviewed unit, and it is not started.
//   - promptForDisclaimerConfirmation: interactive stdio.
//
// ★ THE WALKER IS NOT DUPLICATED. `walkFiles` in the TypeScript is the function carrying the
// measured symlink fix (a mod-manager install leaves the dirent type as a link, so `isFile()` is
// false and every DLL is invisible — 39 false `missing_declared_submodule_dll` alarms on the real
// machine, verified 39/39 false, before the fix). The Go port of a symlink-aware walk already
// exists in internal/mods (WalkModSourceCSharpFiles) with the same dirent-type discipline, and a
// SECOND copy is exactly the shape finding F25 records for the sibling repository: two
// implementations of one rule that drift apart silently. A caller that needs this walker should use
// the existing one rather than a copy grown here.
package bannersetup

import (
	"strings"

	"blore/internal/report"
)

// SetupState mirrors the SetupState type. Only the fields this package needs are modelled; the DLL
// and XML maps are the caller's because their contents come from the copy pass, which is not ported.
type SetupState struct {
	Version        int
	InitializedAt  string
	GameDir        string
	GameVersion    string
	BuildChangeset string
	FullVersion    string
	VersionSource  string
	DLLScope       string
	XMLScope       string
}

// GameVersionInfo mirrors GameVersionInfo.
type GameVersionInfo struct {
	GameVersion    string
	BuildChangeset string
	FullVersion    string
	VersionSource  string
}

// EULADisclaimer mirrors EULA_DISCLAIMER, joined with newlines exactly as the original joins it.
var EULADisclaimer = strings.Join([]string{
	"BannerlordSage Setup Disclaimer",
	"",
	"This tool only automates indexing of game data from a lawfully owned copy of",
	"a supported game for personal learning, research, and modding.",
	"It does not ship or redistribute third-party game assets.",
	"",
	"By continuing you confirm that:",
	"1. You own a legitimate copy of the game.",
	"2. You will comply with the game EULA and local law.",
	"3. You understand the extracted data stays on your local machine.",
}, "\n")

// SplitCLIList mirrors splitCliList.
//
// ★ THREE STEPS, IN THIS ORDER, AND THE ORDER IS OBSERVABLE: split each element on commas, trim
// every piece, then drop the empties. So "a, ,b" yields ["a","b"], and an element that is only
// commas contributes nothing. A version that filtered before trimming would keep a whitespace-only
// piece, because that piece is truthy before the trim.
func SplitCLIList(values []string) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		for _, piece := range strings.Split(value, ",") {
			trimmed := report.TrimJS(piece)
			if trimmed != "" {
				out = append(out, trimmed)
			}
		}
	}
	return out
}

// ComposeFullVersion mirrors composeFullVersion.
//
// ★ IT DOES NOT ALWAYS CONCATENATE. When the game version ALREADY ENDS WITH ".<changeset>" the
// change set is not appended again — so a version that already carries the build number comes back
// unchanged. A port that always joined would produce "1.2.3.1.2.3" for that input.
//
// The second guard is for an ABSENT change set, which returns the version alone; and an absent
// version returns nothing at all, even when a change set is present.
func ComposeFullVersion(gameVersion, buildChangeset string) string {
	if gameVersion == "" {
		return ""
	}
	if buildChangeset == "" {
		return gameVersion
	}
	if strings.HasSuffix(gameVersion, "."+buildChangeset) {
		return gameVersion
	}
	return gameVersion + "." + buildChangeset
}

// GetLogicalModuleName mirrors getLogicalModuleName.
//
// ★ WHEN THE PATH DOES NOT START WITH modules/, THE RETURN IS THE FIRST SEGMENT — and that is not a
// degenerate case, it is the whole point: a copied XML lands under a path relative to the GAME
// ROOT, so a file at `Xmls/foo.xml` yields "Xmls", and a file at `Modules/Native/...` yields
// "Native". A caller counting modules relies on both shapes.
//
// The `filter(Boolean)` drops empty segments, so a leading slash does not shift the answer, and the
// modules/ test is case-insensitive while the RETURNED name keeps its original casing.
func GetLogicalModuleName(relativePath string) string {
	normalized := strings.ReplaceAll(relativePath, `\`, "/")
	parts := make([]string, 0, 4)
	for _, p := range strings.Split(normalized, "/") {
		if p != "" {
			parts = append(parts, p)
		}
	}

	if len(parts) > 1 && strings.ToLower(parts[0]) == "modules" {
		return parts[1]
	}
	if len(parts) > 0 {
		return parts[0]
	}
	return ""
}

// GetPrimaryGameDirEnvName mirrors getPrimaryGameDirEnvName.
//
// ★ THE NORMALISATION IS `[^A-Za-z0-9]+` -> "_" AND THEN UPPERCASE, so it is NOT a trim-and-upper:
// "some game" becomes "SOME_GAME" (one underscore for the space), "a--b" becomes "A_B" (a RUN of
// non-alphanumerics collapses to ONE underscore), and a leading separator becomes a LEADING
// underscore. This name is then read from the environment, so getting the collapsing wrong means
// reading a variable that does not exist — a silent miss rather than an error.
func GetPrimaryGameDirEnvName(gameID string) string {
	return "BANNERSAGE_" + normalizeGameIDForEnv(gameID) + "_GAME_DIR"
}

// GetConfiguredGameDir mirrors getConfiguredGameDir: the per-game variable first, then the generic
// one, then the legacy Bannerlord-only name.
//
// The lookup order matters: a generic BANNERSAGE_GAME_DIR that is SET but EMPTY is falsy in
// JavaScript and therefore falls through to the legacy name, while a non-empty generic value stops
// the search even when a legacy value also exists.
func GetConfiguredGameDir(gameID string, lookup func(string) string) string {
	upper := normalizeGameIDForEnv(gameID)
	if v := lookup("BANNERSAGE_" + upper + "_GAME_DIR"); v != "" {
		return v
	}
	if v := lookup("BANNERSAGE_GAME_DIR"); v != "" {
		return v
	}
	if gameID == "bannerlord" {
		return lookup("BANNERLORD_GAME_DIR")
	}
	return ""
}

// normalizeGameIDForEnv mirrors `gameId.trim().replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()`.
//
// ★ THE TRIM IS JAVASCRIPT'S, NOT Go's TrimSpace — the two disagree on U+FEFF in one direction and
// U+0085 in the other, and this project has already been bitten twice by that substitution.
//
// ★ EVERY RUN OF NON-ALPHANUMERICS BECOMES EXACTLY ONE UNDERSCORE, INCLUDING A LEADING OR TRAILING
// ONE, because that is what a global `replace` does — it rewrites the whole match wherever it sits.
// So "!a" is "_a" and "a!" is "a_", not "a" in either case. Measured, not assumed: the corpus
// contains both, and the first version of this function dropped a LEADING separator, which only the
// differential caught.
func normalizeGameIDForEnv(gameID string) string {
	trimmed := report.TrimJS(gameID)

	var b strings.Builder
	b.Grow(len(trimmed) + 1)
	pendingSeparator := false
	for _, r := range trimmed {
		if isASCIIAlphanumeric(r) {
			if pendingSeparator {
				b.WriteByte('_')
				pendingSeparator = false
			}
			b.WriteRune(r)
			continue
		}
		pendingSeparator = true
	}
	if pendingSeparator {
		b.WriteByte('_')
	}
	return strings.ToUpper(b.String())
}

func isASCIIAlphanumeric(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9')
}
