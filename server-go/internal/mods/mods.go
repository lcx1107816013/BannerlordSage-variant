// Package mods is a port of src/utils/mod-source.ts.
//
// It resolves a local Bannerlord mod source tree (a "[workspaceRoot]" directory, or the
// "--source-dir" value) into an effective C# source root, and derives the per-source cache
// workspace under dist/mod-sources/<sha1 prefix>.
//
// ★ THE WALKER HAS NO CALLER YET. WalkModSourceCSharpFiles, CountModSourceCSharpFiles and
// GetModSourcePaths' cache paths are used by the C# indexer (src/scripts/index-mod-source.ts
// and src/utils/local-mod-csharp-index.ts), which is NOT ported. They are ported anyway so
// the module is complete and the indexer cannot later be written against a guessed contract.
//
// ★ THE ONLY SIDE EFFECT IN THIS PACKAGE IS A MkdirAll of the workspace cache path. The
// TypeScript does `mkdir(workspacePath, { recursive: true })`: it creates directories and
// never removes anything. Ledger F19 records a fixture generator that destroyed a real
// 600 MB index by writing to the path this code resolves, so: do not add cleanup here, and
// do not point these functions at a real mod source tree from a test. A parity harness
// passes its fixture directory EXPLICITLY as the candidate root.
package mods

import (
	"crypto/sha1"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"blore/internal/env"
	"blore/internal/report"
)

// ModSourceIgnoredDirectoryNames mirrors MOD_SOURCE_IGNORED_DIRECTORY_NAMES.
//
// The TypeScript declares it `as const`; Go has no readonly slice, so this is a plain var
// and callers must not mutate it.
var ModSourceIgnoredDirectoryNames = []string{".git", ".idea", ".vs", ".vscode", "bin", "obj"}

// ModSourcePaths mirrors the ModSourcePaths type. The field set is deliberate: a port that
// dropped a field would still pass a value-only comparison, which is how two report paths
// stayed missing from GamePaths.
//
// Note SourceDir and SourceRoot are always the SAME value in the TypeScript (getModSourcePaths
// returns the normalised input for both). Kept as two fields because the TypeScript keeps two.
type ModSourcePaths struct {
	SourceDir         string
	SourceRoot        string
	WorkspaceID       string
	WorkspacePath     string
	CacheRoot         string
	DBPath            string
	CSharpAstDumpPath string
	VersionPath       string
}

// ModSourceWorkspace mirrors `ModSourcePaths & { workspaceRoot }`.
//
// WorkspaceRoot is the RESOLVED CANDIDATE (what the caller asked for), which is NOT
// necessarily SourceRoot: when the candidate contains a `src` directory, SourceRoot points at
// that subdirectory while WorkspaceRoot stays one level up.
type ModSourceWorkspace struct {
	ModSourcePaths
	WorkspaceRoot string
}

// GetConfiguredModSourceDir mirrors getConfiguredModSourceDir.
//
// "" means unset, which is how the TypeScript's `undefined` reaches resolveModSourceDir (the
// only consumer, and it only tests truthiness).
//
// ★ THE PRECEDENCE HAS A SHARP EDGE worth keeping: the TypeScript is
//
//	process.env.BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR || process.env.BANNERSAGE_MOD_SOURCE_DIR
//
// and only THEN is the chosen value trimmed. So a WHITESPACE-ONLY bannerlord variable is
// truthy, wins, and trims to "" — it shadows a perfectly good BANNERSAGE_MOD_SOURCE_DIR
// instead of falling through to it. An empty-string bannerlord variable, by contrast, is
// falsy and does fall through. os.Getenv cannot tell unset from empty, and does not need to.
func GetConfiguredModSourceDir() string {
	value := os.Getenv("BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR")
	if value == "" {
		value = os.Getenv("BANNERSAGE_MOD_SOURCE_DIR")
	}
	return report.TrimJS(value)
}

// EnsureModSourceDir mirrors ensureModSourceDir: the effective C# source root for a candidate.
func EnsureModSourceDir(candidate string) (string, error) {
	workspace, err := ResolveModSourceWorkspace(candidate)
	if err != nil {
		return "", err
	}
	return workspace.SourceRoot, nil
}

// ResolveModSourceDir mirrors resolveModSourceDir.
//
// `candidate?.trim() || configured` — an undefined candidate and an empty/whitespace-only one
// behave identically here, so a plain string parameter carries the whole contract.
//
// The error text is byte-for-byte the TypeScript's, including the double quotes around
// <path>, because the CLI and the ledger both quote it.
func ResolveModSourceDir(candidate string) (string, error) {
	configured := report.TrimJS(candidate)
	if configured == "" {
		configured = GetConfiguredModSourceDir()
	}
	if configured == "" {
		return "", errors.New(`Missing mod source directory. Pass --source-dir "<path>" or set BANNERSAGE_MOD_SOURCE_DIR.`)
	}

	return resolvePath(configured), nil
}

// ResolveModSourceWorkspace mirrors resolveModSourceWorkspace.
//
// The candidate must exist and be a DIRECTORY (stat + isDirectory, i.e. the link is followed),
// and the error names the RESOLVED path rather than the candidate — so a caller passing a
// relative path gets an absolute one back in the message.
func ResolveModSourceWorkspace(candidate string) (ModSourceWorkspace, error) {
	workspaceRoot, err := ResolveModSourceDir(candidate)
	if err != nil {
		return ModSourceWorkspace{}, err
	}

	info, ok := safeStat(workspaceRoot)
	if !ok || !info.IsDir() {
		return ModSourceWorkspace{}, fmt.Errorf("Mod source path is not a directory: %s", workspaceRoot)
	}

	sourceRoot := resolveEffectiveSourceRoot(workspaceRoot)
	paths := GetModSourcePaths(sourceRoot)

	if err := os.MkdirAll(paths.WorkspacePath, 0o755); err != nil {
		return ModSourceWorkspace{}, err
	}

	return ModSourceWorkspace{ModSourcePaths: paths, WorkspaceRoot: workspaceRoot}, nil
}

// GetModSourcePaths mirrors getModSourcePaths.
//
// ★ THE WORKSPACE ID IS DERIVED FROM A NORMALISED PATH, and the normalisation is part of the
// contract: the resolved path with every backslash turned into a forward slash, lowercased,
// then sha1, then the first 12 hex characters. Anything that wants to find this workspace on
// disk (a fixture generator, a debug script) must reproduce all four steps or it will look in
// a directory that does not exist.
//
// ★ DECLARED DIVERGENCE — Unicode case folding, the same one Package env carries. JS
// toLowerCase applies the SpecialCasing table, Go's strings.ToLower only simple case mapping,
// so a path containing e.g. 'İ' (U+0130) hashes differently: JS expands it to "i" + U+0307,
// Go drops the combining dot. Every ASCII path — and therefore every real VS/Xcode-style mod
// path on this machine — hashes identically. The divergence is recorded rather than fixed;
// reproducing SpecialCasing needs a casing table for inputs that cannot occur in practice.
func GetModSourcePaths(sourceDir string) ModSourcePaths {
	normalizedSourceDir := resolvePath(sourceDir)
	workspaceID := workspaceIDFor(normalizedSourceDir)
	workspacePath := filepath.Join(env.DistPath(), "mod-sources", workspaceID)

	return ModSourcePaths{
		SourceDir:         normalizedSourceDir,
		SourceRoot:        normalizedSourceDir,
		WorkspaceID:       workspaceID,
		WorkspacePath:     workspacePath,
		CacheRoot:         workspacePath,
		DBPath:            filepath.Join(workspacePath, "mod-source.db"),
		CSharpAstDumpPath: filepath.Join(workspacePath, "csharp-index.json"),
		VersionPath:       filepath.Join(workspacePath, "Version.txt"),
	}
}

// workspaceIDFor is the createHash('sha1') of getModSourcePaths, split out so the exact input
// bytes are visible in one place.
//
// hex.EncodeToString is lowercase, matching digest('hex'), and the slice keeps the first 12
// characters — not the first 12 bytes of anything.
func workspaceIDFor(normalizedSourceDir string) string {
	key := strings.ToLower(strings.ReplaceAll(normalizedSourceDir, `\`, `/`))
	sum := sha1.Sum([]byte(key))
	return hex.EncodeToString(sum[:])[:12]
}

// CountModSourceCSharpFiles mirrors countModSourceCSharpFiles.
//
// A walker error propagates (the TypeScript's `for await` rethrows) instead of returning a
// partial count, so "unreadable subdirectory" can never look like "smaller project".
func CountModSourceCSharpFiles(sourceRoot string) (int, error) {
	count := 0
	err := WalkModSourceCSharpFiles(sourceRoot, func(string) error {
		count++
		return nil
	})
	if err != nil {
		return 0, err
	}
	return count, nil
}

// WalkModSourceCSharpFiles mirrors walkModSourceCSharpFiles, an async generator. The yield
// becomes a callback: fn is called once per matching path in walk order, and a non-nil error
// from fn stops the walk and is returned.
//
// ★ DIRECTORY-NESS COMES FROM THE READDIR ENTRY, NOT FROM A STAT. Node's Dirent.isDirectory()
// reflects the FILE_ATTRIBUTE_* bits, so on Windows a junction or a directory symlink is
// NEITHER a directory NOR a file and is silently skipped — not descended into, not yielded.
// Go's os.DirEntry makes the same distinction (IsDir() is false and Type() is ModeSymlink or
// ModeIrregular for a reparse point), so the check below mirrors it. A tempting rewrite —
// `os.Stat` per entry — follows the link and would both descend into junctions (a self-
// referential junction then recurses until the stack dies) and treat a symlinked directory
// as a directory where the original does not.
//
// ★ ORDER — a recorded deviation. The TypeScript yields in readdir order, which is the
// filesystem's enumeration order and is machine-dependent; measured on NTFS it happens to be
// uppercase-first index order. os.ReadDir sorts by filename bytes, which is deterministic, so
// this port yields a defined order where the original had an undefined one. Nothing consumes
// the order yet (CountModSourceCSharpFiles only counts), and no caller may rely on the
// TypeScript order because there is not one.
func WalkModSourceCSharpFiles(dir string, fn func(filePath string) error) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		name := entry.Name()
		fullPath := filepath.Join(dir, name)

		if entry.IsDir() {
			if ShouldSkipModSourceDirectory(name) {
				continue
			}
			if err := WalkModSourceCSharpFiles(fullPath, fn); err != nil {
				return err
			}
			continue
		}

		// isFile() half of the original test. Only a regular entry is a file; a reparse point
		// is not, which is what keeps the walk from following links.
		if entry.Type().IsRegular() && strings.HasSuffix(strings.ToLower(name), ".cs") {
			if err := fn(fullPath); err != nil {
				return err
			}
		}
	}

	return nil
}

// ShouldSkipModSourceDirectory mirrors shouldSkipModSourceDirectory.
//
// ★ THE COMPARISON IS EXACT EQUALITY AGAINST A TRIMMED, LOWERCASED NAME — not a prefix test,
// not a substring test, not a case-insensitive comparison of the raw name. Consequences that
// a "tidier" implementation loses:
//
//	" Bin "  -> "bin"  -> SKIPPED
//	".GIT"   -> ".git" -> SKIPPED
//	"binx"   -> "binx" -> NOT skipped
//	".git."  -> ".git." -> NOT skipped
//
// The trim is JavaScript's (report.TrimJS), which removes U+FEFF where strings.TrimSpace does
// not and keeps U+0085 where TrimSpace would remove it: "\ufeffbin" IS skipped by the
// original. Using TrimSpace here would let a BOM-prefixed build directory through.
//
// ★ DECLARED DIVERGENCE — Unicode case folding (same class as GetModSourcePaths above, but
// HERE IT IS OBSERVABLE): measured, "\u0130" (İ) lowercases to "i" + U+0307 in JS and to "i"
// in Go, so the directory name "BİN" trims+lowercases to "bi̇n" in the TypeScript (NOT in the
// ignore list, so it is walked) and to "bin" here (skipped). A Turkish-cased build directory
// is the only way to reach it; ASCII names — every name in the actual ignore list — match
// exactly, and ToLower is used as the declared substitute.
func ShouldSkipModSourceDirectory(name string) bool {
	normalized := strings.ToLower(report.TrimJS(name))
	for _, candidate := range ModSourceIgnoredDirectoryNames {
		if candidate == normalized {
			return true
		}
	}
	return false
}

// resolveEffectiveSourceRoot mirrors the module-private resolveEffectiveSourceRoot.
//
// A root whose basename is already `src` is used as-is; otherwise a `src` SUBDIRECTORY wins
// when it exists; otherwise the root itself. The basename test is case-insensitive, and the
// subdirectory test is a stat, so a `src` that is a FILE does not win — the stat's IsDir()
// decides. (fs.stat follows links, so a symlink to a directory named `src` DOES win; that is
// the TypeScript's behaviour too, since it stats and the Dirent rule above does not apply here.)
func resolveEffectiveSourceRoot(workspaceRoot string) string {
	if strings.ToLower(filepath.Base(workspaceRoot)) == "src" {
		return workspaceRoot
	}

	srcCandidate := filepath.Join(workspaceRoot, "src")
	if info, ok := safeStat(srcCandidate); ok && info.IsDir() {
		return srcCandidate
	}

	return workspaceRoot
}

// safeStat mirrors safeStat: stat, and swallow EVERY error as "absent".
//
// The swallow is the point: it is what turns "no such path" and "permission denied" into the
// same answer, so an unreadable path reports "not a directory" rather than leaking an errno.
// os.Stat, not Lstat — the TypeScript's fs.stat follows links.
func safeStat(path string) (os.FileInfo, bool) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, false
	}
	return info, true
}

// resolvePath mirrors the TypeScript's resolve() for the values that reach it here.
//
// ★ MEASURED DEVIATION on Windows, recorded rather than papered over. node's path.resolve is
// purely LEXICAL; Go's filepath.Abs goes through the Win32 layer. Measured differences:
//
//	input           node resolve     Go Abs
//	"D:\x.\y"       "D:\x.\y"        "D:\x\y"      (trailing dot per component stripped)
//	"D:\x "         "D:\x "          "D:\x"        (trailing space stripped)
//	"C:foo"         "<cwd on C:>\foo" "C:foo"      (drive-relative form)
//
// Win32 itself strips trailing dots and spaces from a path component when it resolves one, so
// the first two inputs cannot name a directory that exists as written: the divergent inputs
// are unreachable for an input that is a real directory. The third cannot be produced by the
// CLI or by the env vars, which pass absolute paths. Abs is also the convention this port
// already uses (see textfilecache.ReadSlice), so resolve() is mirrored by Abs everywhere.
//
// The Abs error path is unreachable for real paths; a lexical Clean is used so that a rejected
// path still flows into the caller's "not a directory" stat failure instead of inventing a new
// error mode the TypeScript does not have.
func resolvePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}
