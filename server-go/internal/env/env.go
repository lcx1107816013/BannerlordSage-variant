// Package env resolves repository/game paths for the blore Go server.
//
// Port of src/utils/env.ts. The TS version derives the repo root from
// import.meta.dir (source location). The Go binary is a standalone static
// executable, so the root is resolved in this order:
//
//  1. BLORE_ROOT environment variable (recommended: set it in mcp.json)
//  2. walk up from the executable directory looking for a repo marker
//  3. walk up from the current working directory looking for a repo marker
//
// A repo marker is a directory containing BOTH "package.json" AND "dist".
package env

import (
	"os"
	"path/filepath"
	"strings"
)

const DefaultGameID = "bannerlord"

// GamePaths mirrors getGamePaths() in src/utils/env.ts.
//
// The field set is asserted against the TypeScript's own key set by the parity suite:
// a port that silently drops a field would otherwise pass a value-only comparison,
// which is exactly how ReportsPath's two report paths stayed missing.
type GamePaths struct {
	GameID            string
	Root              string
	GameDistPath      string
	AssetsPath        string
	ReportsPath       string
	VersionPath       string
	DefsPath          string
	SourcePath        string
	DBPath            string
	MemoryDBPath      string
	SetupStatePath    string
	CSharpAstDumpPath string
	// The TypeScript also returns these two; they were absent from the port.
	XMLParseReportPath         string
	XMLParseReportMarkdownPath string
}

// jsWhitespace is the ECMAScript WhiteSpace + LineTerminator set.
//
// The TypeScript is `gameId?.trim().toLowerCase()`, and JS trim() is NOT Go's
// strings.TrimSpace: they trim different sets, in BOTH directions.
//
//	U+FEFF BOM/ZWNBSP : JS trims it, Go TrimSpace does NOT   (Go IsSpace=false)
//	U+0085 NEL        : Go TrimSpace trims it, JS does NOT   (Go IsSpace=true)
//
// Measured, and it matters here: `normalizeGameId("\ufeffX")` must be "x" but
// strings.TrimSpace leaves the BOM and yields "\ufeffx". A BOM-prefixed game id is
// plausible (read from a file), so this is not a theoretical case.
const jsWhitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0" +
	"\u1680" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

// jsTrim mirrors JavaScript's String.prototype.trim().
func jsTrim(s string) string {
	return strings.Trim(s, jsWhitespace)
}

// NormalizeGameID mirrors normalizeGameId(): trim + lowercase, empty -> default.
//
// ★ DECLARED DIVERGENCE — Unicode case folding.
//
// JavaScript's toLowerCase() implements the Unicode SpecialCasing table; Go's
// strings.ToLower implements only SIMPLE case mapping. The two disagree on
// non-ASCII input, measured:
//
//	input        TypeScript      Go
//	"İSTANBUL"   "i̇stanbul"      "istanbul"     (U+0130 expands to i + U+0307)
//	"ΣΊΣΥΦΟΣ"     "σίσυφος"       "σίσυφοσ"      (final sigma, U+03C2)
//
// This is NOT reproduced, deliberately. A game id is a slug ("bannerlord",
// "other-game"), so the divergent inputs are outside the function's real domain, and
// reproducing SpecialCasing would mean embedding a casing table to handle inputs that
// cannot occur. The divergence is recorded in the parity fixtures and asserted there
// rather than left implicit, so it cannot silently widen.
//
// Everything ASCII — and therefore every real game id — matches exactly.
func NormalizeGameID(gameID string) string {
	normalized := strings.ToLower(jsTrim(gameID))
	if normalized == "" {
		return DefaultGameID
	}
	return normalized
}

// ActiveGameID mirrors getActiveGameId(): BANNERSAGE_GAME, then
// BANNERLORDSAGE_GAME, then the default.
func ActiveGameID() string {
	gameID := os.Getenv("BANNERSAGE_GAME")
	if gameID == "" {
		gameID = os.Getenv("BANNERLORDSAGE_GAME")
	}
	return NormalizeGameID(gameID)
}

// RootDir resolves the repository root as described in the package comment.
func RootDir() string {
	if r := strings.TrimSpace(os.Getenv("BLORE_ROOT")); r != "" {
		return filepath.Clean(r)
	}
	if exe, err := os.Executable(); err == nil {
		if r := walkUpForRoot(filepath.Dir(exe)); r != "" {
			return r
		}
	}
	if wd, err := os.Getwd(); err == nil {
		if r := walkUpForRoot(wd); r != "" {
			return r
		}
	}
	return ""
}

// walkUpForRoot climbs at most 10 levels looking for a repo marker directory.
func walkUpForRoot(start string) string {
	dir := start
	for i := 0; i < 10; i++ {
		if isRepoRoot(dir) {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

func isRepoRoot(dir string) bool {
	if _, err := os.Stat(filepath.Join(dir, "package.json")); err != nil {
		return false
	}
	info, err := os.Stat(filepath.Join(dir, "dist"))
	return err == nil && info.IsDir()
}

// GetGamePaths mirrors getGamePaths() in src/utils/env.ts. Empty gameID falls
// back to the active game id from the environment.
func GetGamePaths(gameID string) GamePaths {
	if strings.TrimSpace(gameID) == "" {
		gameID = ActiveGameID()
	}
	id := NormalizeGameID(gameID)
	root := RootDir()
	gameDistPath := filepath.Join(root, "dist", "games", id)
	assetsPath := filepath.Join(gameDistPath, "assets")
	reportsPath := filepath.Join(gameDistPath, "reports")

	return GamePaths{
		GameID:            id,
		Root:              root,
		GameDistPath:      gameDistPath,
		AssetsPath:        assetsPath,
		ReportsPath:       reportsPath,
		VersionPath:       filepath.Join(gameDistPath, "Version.txt"),
		DefsPath:          filepath.Join(assetsPath, "Xmls"),
		SourcePath:        filepath.Join(assetsPath, "Source"),
		DBPath:            filepath.Join(gameDistPath, id+".db"),
		MemoryDBPath:      filepath.Join(gameDistPath, id+"-memory.db"),
		SetupStatePath:    filepath.Join(gameDistPath, "setup-state.json"),
		CSharpAstDumpPath: filepath.Join(gameDistPath, "csharp-index.json"),
		// These two live under reportsPath, not gameDistPath.
		XMLParseReportPath:         filepath.Join(reportsPath, "xml-parse-report.json"),
		XMLParseReportMarkdownPath: filepath.Join(reportsPath, "xml-parse-report.md"),
	}
}

// DistPath mirrors `export const distPath = join(root, 'dist')` in src/utils/env.ts.
//
// A function rather than a var, like RootDir above: a package-level var would freeze the
// root at init time, before BLORE_ROOT is read.
func DistPath() string {
	return filepath.Join(RootDir(), "dist")
}
