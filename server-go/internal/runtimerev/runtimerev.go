// Package runtimerev ports src/utils/runtime-revision.ts.
//
// The TypeScript keeps two observed-revision maps — one keyed by GAME ID
// (ensureRuntimeRevisionFresh) and one keyed by VERSION-FILE PATH (ensureRevisionFresh) —
// plus a write path that updates the path-keyed map and a read-only accessor. The
// path-keyed half was ported first (read-gauntlet-ui.ts was its only caller); the game-keyed
// half arrives with this server skeleton, because src/utils/db.ts's getDb calls
// ensureRuntimeRevisionFresh(gameId) on every open and registers closeDb as an invalidator,
// and internal/store is the Go mirror of that module.
package runtimerev

import (
	"os"
	"sync"

	"blore/internal/env"
	"blore/internal/report"
)

var (
	mu sync.Mutex
	// invalidators is a SLICE, not a map: the TypeScript iterates a Set, which visits
	// entries in insertion order, and Go map iteration is randomised.
	invalidators []func()
	// observedRevisionByPath mirrors observedRevisionByPath. "No entry" and "an entry
	// holding an empty revision" are different states, which is why every lookup below
	// uses the two-value form.
	observedRevisionByPath = map[string]string{}
	// observedRevisionByGame mirrors observedRevisionByGame, keyed by the NORMALISED game
	// id (normalizeGameId runs before the map sees the key, so 'BANNERLORD' and
	// 'bannerlord' are one observation, and '' normalises to the default id too).
	observedRevisionByGame = map[string]string{}
)

// RegisterInvalidator mirrors registerRuntimeInvalidator. The TypeScript also returns an
// unregister closure; nothing in this port needs it.
func RegisterInvalidator(invalidator func()) {
	mu.Lock()
	invalidators = append(invalidators, invalidator)
	mu.Unlock()
}

// EnsureRuntimeRevisionFresh mirrors ensureRuntimeRevisionFresh(gameId): the observation key
// is the NORMALISED game id, while the revision file read is that game's Version.txt.
//
// ★ TWO GAMES CAN SHARE ONE OBSERVATION KEY BY CONSTRUCTION — this port has one game
// profile, so the key is always the default id today — and one game id CANNOT collide with
// a path key here because the path key is an absolute filesystem path while the game key is
// a slug ('bannerlord'). The TypeScript keeps the same two maps with the same key spaces;
// a path that happened to equal a game id would observe twice, which is the original's
// behaviour too.
func EnsureRuntimeRevisionFresh(gameID string) bool {
	normalized := env.NormalizeGameID(gameID)
	return ensureRevisionFreshForKey(normalized, env.GetGamePaths(normalized).VersionPath, observedRevisionByGame)
}

// ReadRuntimeRevision mirrors readRuntimeRevision(gameId): the raw file content, '' when
// absent or unreadable. It does NOT touch the observation maps — reading is not observing,
// so it cannot accidentally "seed" a key and suppress a later change notification.
func ReadRuntimeRevision(gameID string) string {
	return readRevisionFile(env.GetGamePaths(gameID).VersionPath)
}

// EnsureFresh mirrors ensureRevisionFresh(versionPath).
//
// ★ IT IS THIS ENTRYPOINT, NOT EnsureRuntimeRevisionFresh() , THAT read-gauntlet-ui's
// TypeScript reaches. read-gauntlet-ui.ts calls `ensureRuntimeRevisionFresh()` with no
// argument, and runtime-revision.ts normalises an absent id to the DEFAULT game id
// ('bannerlord') *before* passing it to getGamePaths — so getGamePaths' own
// `= getActiveGameId()` default parameter never fires on this path. The version file watched
// by the tool is therefore always the default game's, even when BANNERSAGE_GAME names
// another game. Ported as found; see the port report.
//
// The observation key IS the version path string as given (ensureRevisionFresh passes
// versionPath as both arguments), so two spellings of one file are two independent
// observations.
//
// Returns true only when a revision was observed BEFORE and has CHANGED. The FIRST
// observation records the revision and returns false without firing anything, which is
// what makes "the file appeared" and "the file was rewritten" both count as changes while
// "the tool ran for the first time" does not.
func EnsureFresh(versionPath string) bool {
	return ensureRevisionFreshForKey(versionPath, versionPath, observedRevisionByPath)
}

// ensureRevisionFreshForKey mirrors ensureRevisionFreshForKey: the one loop body both
// public entry points share. It is the same five steps in the same order as the TypeScript —
// read, look up, seed-or-compare, store, fire — so both key spaces behave identically.
func ensureRevisionFreshForKey(observationKey, versionPath string, observedRevisions map[string]string) bool {
	revision := readRevisionFile(versionPath)

	mu.Lock()
	previous, observed := observedRevisions[observationKey]
	if !observed {
		observedRevisions[observationKey] = revision
		mu.Unlock()
		return false
	}
	if previous == revision {
		mu.Unlock()
		return false
	}
	observedRevisions[observationKey] = revision
	// Snapshot, then release before firing. The invalidators clear OTHER packages'
	// caches, so holding this lock across them would invite a deadlock (this lock, then
	// that package's lock, while that package's caller holds its lock and waits here).
	// The snapshot is equivalent to the Set iteration because no invalidator registers
	// another one.
	pending := invalidators
	pending = append([]func(){}, pending...)
	mu.Unlock()

	for _, invalidator := range pending {
		invalidator()
	}
	return true
}

// readRevisionFile mirrors readRevisionFile(versionPath): "" for a missing file, "" for
// any read failure, and the trimmed contents otherwise.
//
// ★ THE TWO EMPTY CASES COLLAPSE ON PURPOSE. That is the TypeScript's contract, and its
// consequence is real: a Version.txt that is deleted and a Version.txt that becomes
// unreadable are indistinguishable to every caller, and both count as a CHANGE whenever
// the previous observation was non-empty.
//
// The trim is JS trim(), not strings.TrimSpace — they disagree on U+FEFF, which JS strips
// and Go does not, and a Version.txt written with a BOM is the plausible case here.
func readRevisionFile(versionPath string) string {
	// existsSync() then readFileSync() in a try/catch. A path that exists but is a
	// directory reaches the same "" through the read error, as it does in the original.
	if _, err := os.Stat(versionPath); err != nil {
		return ""
	}
	raw, err := os.ReadFile(versionPath)
	if err != nil {
		return ""
	}
	// ★ NOT MIRRORED, stated rather than hidden: readFileSync(path, 'utf8') decodes as
	// UTF-8, so invalid bytes become U+FFFD, while Go hands back the raw bytes. The value
	// is only ever compared for equality, so this can differ only for a corrupt file.
	return report.TrimJS(string(raw))
}
