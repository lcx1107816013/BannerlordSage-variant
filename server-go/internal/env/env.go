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
}

// NormalizeGameId mirrors normalizeGameId(): trim+lowercase, empty -> default.
func NormalizeGameID(gameID string) string {
	normalized := strings.ToLower(strings.TrimSpace(gameID))
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
	}
}
