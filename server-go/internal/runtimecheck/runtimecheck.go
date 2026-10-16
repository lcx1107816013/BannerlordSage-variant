// Package runtimecheck ports src/utils/runtime-check.ts: the two readiness probes that answer
// "is the index able to serve queries for the active game".
//
// ★ READINESS IS PROFILE-GATED, NOT A SINGLE FILE TEST. Each artifact counts only if the game's
// profile REQUIRES it, so a game that needs no decompiled source is ready without a source tree —
// while a game that needs one is not ready with an empty one. Both functions therefore take the
// three `requires` flags rather than reading a profile themselves, so the port does not have to
// carry the profile registry (which the TypeScript's own file keeps for detection, and which this
// port deliberately does not: see internal/gameprofiles' note on what is NOT ported).
//
// ★ THE TWO PROBES ARE NOT THE SAME QUESTION. The readiness probe asks only whether each directory
// exists and holds at least ONE file — it stops at the first entry — while the status probe COUNTS
// every file. So on a large assets tree the first is cheap and the second walks the whole thing.
//
// ★ BOTH GATE ON EXISTENCE FIRST, so a missing directory yields `false` / `0` WITHOUT a walk, and a
// walk error therefore only arises for a directory that exists but cannot be read. Whether the two
// then diverge is NOT measured here, and this comment does not claim it: the original's `readdir`
// throws in both paths, so the port propagates the error from both as well.
package runtimecheck

import (
	"errors"
	"os"
	"path/filepath"
)

// Requires mirrors the three `requires` flags of a GameProfile.
type Requires struct {
	Source bool
	XML    bool
	DB     bool
}

// Readiness mirrors the return of getInitializationReadiness.
type Readiness struct {
	GameID   string
	Ready    bool
	DBExists bool
}

// Status mirrors the return of getInitializationStatus.
type Status struct {
	GameID      string
	Ready       bool
	SourceFiles int
	XMLFiles    int
	DBExists    bool
}

// GetReadiness mirrors getInitializationReadiness.
//
// ★ THE SOURCE AND XML PROBES ARE SKIPPED WHEN THE PROFILE DOES NOT REQUIRE THEM, and the result is
// `false`, NOT `true`: the TypeScript resolves them to `Promise.resolve(false)` and then guards each
// term with `!requires || probe`. So the value is never read in that case — and a port that filled
// in `true` would still produce the same `ready`, but would report a different intermediate. The
// distinction is kept so the shape matches the original.
func GetReadiness(gameID string, requires Requires, sourcePath, defsPath, dbPath string) (Readiness, error) {
	sourceReady := false
	if requires.Source {
		ok, err := DirectoryHasFiles(sourcePath)
		if err != nil {
			return Readiness{}, err
		}
		sourceReady = ok
	}

	xmlReady := false
	if requires.XML {
		ok, err := DirectoryHasFiles(defsPath)
		if err != nil {
			return Readiness{}, err
		}
		xmlReady = ok
	}

	dbExists, err := FileExists(dbPath)
	if err != nil {
		return Readiness{}, err
	}

	return Readiness{
		GameID: gameID,
		Ready: (!requires.Source || sourceReady) &&
			(!requires.XML || xmlReady) &&
			(!requires.DB || dbExists),
		DBExists: dbExists,
	}, nil
}

// GetStatus mirrors getInitializationStatus.
//
// ★ THE COUNTS RUN EVEN FOR ARTIFACTS THE PROFILE DOES NOT REQUIRE — unlike the readiness probe,
// which skips them. So a game that needs no XML still reports its xml file count. That is the
// original's behaviour and it is why the two functions cannot share an implementation.
func GetStatus(gameID string, requires Requires, sourcePath, defsPath, dbPath string) (Status, error) {
	sourceFiles, err := CountFilesInDirectory(sourcePath)
	if err != nil {
		return Status{}, err
	}
	xmlFiles, err := CountFilesInDirectory(defsPath)
	if err != nil {
		return Status{}, err
	}
	dbExists, err := FileExists(dbPath)
	if err != nil {
		return Status{}, err
	}

	return Status{
		GameID:      gameID,
		Ready:       (!requires.Source || sourceFiles > 0) && (!requires.XML || xmlFiles > 0) && (!requires.DB || dbExists),
		SourceFiles: sourceFiles,
		XMLFiles:    xmlFiles,
		DBExists:    dbExists,
	}, nil
}

// walkFiles mirrors the module-private walkFiles of src/utils/bannerlord-setup.ts, which is the
// ONLY file walker the two probes use.
//
// ★ WHY THIS IS NOT REUSED FROM ANOTHER PACKAGE. internal/mods walks a MOD SOURCE tree and filters
// for C# files; internal/tools' walkers filter for XML. Neither is the generic "yield every file"
// walker this needs, and bending one of them into it would put a filter inside a caller. The
// SYMLINK RULE, however, is the part that must not drift — see below — and it is stated once here
// in the same terms as the others.
//
// ★ THE SYMLINK CASE IS THE WHOLE POINT OF THE ORIGINAL LOOP. readdir's dirents describe the
// DIRECTORY ENTRY, not the target, so `isFile()` is FALSE for a symlinked file. The TypeScript's
// comment records the measurement: 110 of 111 entries in a Vortex-managed module's bin directory
// are symbolic links, and before the fix the walk collected no DLLs at all, which made
// `bannerlord_doctor` emit 39 false "declared but missing" alarms (all 39 verified false). The rule
// is therefore: follow the link and test the TARGET — a directory recurses, a file counts, and a
// DANGLING link is skipped rather than reported.
//
// ★ A DIRECTORY JUNCTION IS `isSymbolicLink() === true` IN NODE, WHICH GO DOES NOT REPORT THAT WAY —
// and this was a REAL, MEASURED DIVERGENCE in the first version of this walker. Measured on this host
// for the same directory:
//
//	same entry    Go os.ReadDir                bun readdirSync({withFileTypes})
//	junction_dir  Type() = ModeIrregular,      isSymbolicLink() = TRUE
//	              symlink bit NOT set,         isDirectory() = FALSE, isFile() = FALSE
//	              IsDir() = FALSE              stat: a directory
//	hardlink      Type() = regular             isFile() = TRUE
//
// The TypeScript's `if (entry.isSymbolicLink())` therefore MATCHES a junction, and the walk descends
// through it, while a Go test on `Type()&os.ModeSymlink` does not. The A/B on a tree with one
// junction and three files measured the consequence: the TypeScript counts 4 files (visiting the
// target's file twice, once through each name) and the first version of this port counted 3.
//
// So the test below mirrors what Node reports rather than what Go's dirent says: an entry that is not
// a directory and not a regular file is treated as a LINK and stat'd, which covers symlinks,
// junctions and any other reparse point in one branch. internal/tools/gauntletui.go's walker is the
// deliberate opposite (it does NOT descend) because the bun code IT mirrors does not — two walkers,
// two measured behaviours.
func walkFiles(dir string, fn func(filePath string) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		fullPath := filepath.Join(dir, entry.Name())
		if entry.IsDir() {
			if err := walkFiles(fullPath, fn); err != nil {
				return err
			}
			continue
		}
		if entry.Type().IsRegular() {
			if err := fn(fullPath); err != nil {
				return err
			}
			continue
		}
		// ★ NODE'S `isSymbolicLink()` IS TRUE FOR A JUNCTION EVEN THOUGH GO'S TYPE BITS DO NOT SAY SO,
		// so the branch is entered for ANY non-directory, non-regular entry and the TARGET decides.
		// Testing only `ModeSymlink` would skip every junction — which is precisely the bug measured
		// above. A stat that fails (a dangling link) is skipped, as the original does.
		info, statErr := os.Stat(fullPath)
		if statErr != nil {
			continue
		}
		if info.IsDir() {
			if err := walkFiles(fullPath, fn); err != nil {
				return err
			}
			continue
		}
		if info.Mode().IsRegular() {
			if err := fn(fullPath); err != nil {
				return err
			}
		}
	}
	return nil
}

// FileExists mirrors fileExists: a stat that reports an error as absence.
//
// ★ IT TRUSTS THE CALLER'S PATH AND FOLLOWS SYMLINKS, because `stat` does. A DANGLING symlink
// therefore reads as ABSENT (the stat fails), which is the behaviour the probe wants: a symlinked
// asset tree that points nowhere is not ready.
func FileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	// The TypeScript's catch swallows EVERY error, not just ENOENT — a permission error reads as
	// absence rather than as a failure. Reproducing that here rather than propagating: a readiness
	// probe that errored on an unreadable directory would turn "cannot tell" into "not ready".
	return false, nil
}

// CountFilesInDirectory mirrors countFilesInDirectory: 0 when the path does not exist, an exhaustive
// count otherwise, and an ERROR when the path exists but is NOT a directory.
//
// ★ THE FILE-AS-DIRECTORY CASE IS AN ERROR, NOT A ZERO — measured against the TypeScript with bun
// 1.4.3, because the two predicates differ there and guessing would have got it wrong:
//
//	a FILE       fileExists=true  directoryHasFiles=THREW(ENOTDIR)  countFilesInDirectory=THREW(ENOTDIR)
//	an EMPTY dir fileExists=true  directoryHasFiles=false            countFilesInDirectory=0
//	a nested dir fileExists=true  directoryHasFiles=true             countFilesInDirectory=1
//	a MISSING    fileExists=false directoryHasFiles=false            countFilesInDirectory=0
//
// So `fileExists` returning true is NOT enough to proceed: the walk itself throws ENOTDIR. The first
// version of this port returned 0 for that input, which would have turned a misconfigured path into
// a silently "not ready" game rather than an error a caller can see.
func CountFilesInDirectory(dir string) (int, error) {
	exists, err := FileExists(dir)
	if err != nil || !exists {
		return 0, err
	}
	// The walk must fail the way readdir fails: a path that is not a directory is an error.
	if info, statErr := os.Stat(dir); statErr != nil {
		return 0, statErr
	} else if !info.IsDir() {
		return 0, errNotADirectory(dir)
	}

	count := 0
	if err := walkFiles(dir, func(string) error {
		count++
		return nil
	}); err != nil {
		return 0, err
	}
	return count, nil
}

// DirectoryHasFiles mirrors directoryHasFiles: stop at the FIRST file, and error on a
// non-directory.
//
// It is exported because runtime-check's module-public surface is these three predicates plus the two
// probes, and a differential test drives the predicates directly — the composition (`!requires ||
// probe`) is the probes' only own logic and is covered separately.
func DirectoryHasFiles(dir string) (bool, error) {
	exists, err := FileExists(dir)
	if err != nil || !exists {
		return false, err
	}
	if info, statErr := os.Stat(dir); statErr != nil {
		return false, statErr
	} else if !info.IsDir() {
		return false, errNotADirectory(dir)
	}

	found := false
	err = walkFiles(dir, func(string) error {
		found = true
		// The TypeScript's `return true` inside the for-await ends the walk; the error below is how
		// this port stops it, and it is swallowed right here rather than reported.
		return errStopWalk
	})
	if err != nil && err != errStopWalk {
		return found, err
	}
	return found, nil
}

// errNotADirectory mirrors the ENOTDIR a `readdir` on a file raises.
//
// The TypeScript does not catch this: `directoryHasFiles` and `countFilesInDirectory` both call
// `walkFiles`, whose `readdir` throws, and the throw propagates out of `getInitializationStatus`.
// So a caller of the port sees an error here where it would see an exception there — the same
// contract, expressed the way Go expresses it.
func errNotADirectory(path string) error {
	return &os.PathError{Op: "readdir", Path: path, Err: errENOTDIR}
}

// errENOTDIR is the POSIX code the TypeScript's error carries. It is declared here rather than
// imported so the message matches on every platform, including the ones whose syscall package does
// not export it.
var errENOTDIR = errors.New("not a directory")

// errStopWalk ends the walk early, mirroring `return true` inside the TypeScript's for-await loop.
// It is never returned to a caller: the two functions that can trigger it swallow it themselves.
var errStopWalk = errors.New("runtimecheck: stop walk (a file was found)")
