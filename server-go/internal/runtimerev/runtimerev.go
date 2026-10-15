// Package runtimerev ports the part of src/utils/runtime-revision.ts that this server
// calls: the path-keyed freshness check.
//
// The TypeScript keeps two observed-revision maps — one keyed by GAME ID
// (ensureRuntimeRevisionFresh) and one keyed by VERSION-FILE PATH (ensureRevisionFresh).
// Only the path-keyed one is reachable from read-gauntlet-ui.ts, so only it is ported. The
// game-keyed map, the write path (writeRuntimeRevision / writeRevisionFile) and the
// read-only accessor (readRuntimeRevision) are deliberately absent rather than guessed;
// whoever ports src/utils/db.ts will need ensureRuntimeRevisionFresh(gameId) and should add
// it together with that caller.
package runtimerev

import (
	"os"
	"sync"

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
)

// RegisterInvalidator mirrors registerRuntimeInvalidator. The TypeScript also returns an
// unregister closure; nothing in this port needs it.
func RegisterInvalidator(invalidator func()) {
	mu.Lock()
	invalidators = append(invalidators, invalidator)
	mu.Unlock()
}

// EnsureFresh mirrors ensureRevisionFresh(versionPath).
//
// ★ IT IS THIS ENTRY POINT, NOT ensureRuntimeRevisionFresh(), THAT THE TOOL REACHES.
// read-gauntlet-ui.ts calls `ensureRuntimeRevisionFresh()` with no argument, and
// runtime-revision.ts:17 normalises an absent id to the DEFAULT game id ('bannerlord')
// *before* passing it to getGamePaths — so getGamePaths' own `= getActiveGameId()` default
// parameter never fires on this path. The version file watched by the tool is therefore
// always the default game's, even when BANNERSAGE_GAME names another game. Ported as
// found; see the port report.
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
	revision := readRevisionFile(versionPath)

	mu.Lock()
	previous, observed := observedRevisionByPath[versionPath]
	if !observed {
		observedRevisionByPath[versionPath] = revision
		mu.Unlock()
		return false
	}
	if previous == revision {
		mu.Unlock()
		return false
	}
	observedRevisionByPath[versionPath] = revision
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
