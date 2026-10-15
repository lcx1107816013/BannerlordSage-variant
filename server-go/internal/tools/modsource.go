package tools

import (
	"blore/internal/mods"
	"blore/internal/sandbox"
)

// The two thin tools over the local mod source tree. Each is the same three lines as the
// TypeScript: resolve the source directory, build a sandbox on it, delegate UNCHANGED.
//
// The delegation is the whole contract, so both bodies deliberately add nothing — no extra
// validation, no path cleanup, no error rewriting. Everything observable (the rendered report,
// the slice clamping, the error text) comes from ListDirectory / ReadFile in files.go, which
// have their own parity suite.
//
// ★ DEFAULT ARGUMENTS ARE THE CALLER'S JOB. The TypeScript declares
// `listModDirectory(workspaceRoot, relativePath = '')` and
// `readModFile(workspaceRoot, path, startLine = 0, lineCount = 400)`, but the defaults are
// supplied twice over in the original: once in the function signature and once in the MCP
// input schema (`z.number().optional().default(0)` etc. in src/server.ts). Go has no default
// parameters, so the MCP registration supplies the same values ('' / 0 / 400), exactly as it
// does for read_file and list_directory in files.go. The bodies below are reached ONLY with
// concrete values, which is why an omitted `startLine` cannot be told apart from an explicit 0
// at this layer.

// ListModDirectory mirrors listModDirectory(workspaceRoot, relativePath = ”) from
// src/tools/list-mod-directory.ts.
//
// An empty workspaceRoot means "undefined": the source directory then comes from
// BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR / BANNERSAGE_MOD_SOURCE_DIR (see mods.ResolveModSourceDir).
//
// ★ The sandbox is rooted at the RESOLVED SOURCE ROOT, not at the workspace root the caller
// passed. When the candidate contains a `src` directory the two differ by one level, so a path
// that is valid relative to one is rejected relative to the other. Mirrored, not smoothed over.
//
// ★ Resolving the directory can CREATE the per-source cache directory under dist/mod-sources
// (see mods.ResolveModSourceWorkspace). That side effect is the original's, and it happens
// before the sandbox exists — so a listing can succeed while creating a directory elsewhere.
func ListModDirectory(workspaceRoot, relativePath string) (string, error) {
	sourceDir, err := mods.EnsureModSourceDir(workspaceRoot)
	if err != nil {
		return "", err
	}
	return ListDirectory(sandbox.New("", sourceDir), relativePath)
}

// ReadModFile mirrors readModFile(workspaceRoot, path, startLine = 0, lineCount = 400) from
// src/tools/read-mod-file.ts.
//
// The slice semantics are ReadFile's, including the defaults' clamping: a negative or
// out-of-range startLine is handled there, and the rendered report echoes the REQUEST values
// rather than the clamped ones. Nothing is normalised here.
func ReadModFile(workspaceRoot, relativePath string, startLine, lineCount int) (string, error) {
	sourceDir, err := mods.EnsureModSourceDir(workspaceRoot)
	if err != nil {
		return "", err
	}
	return ReadFile(sandbox.New("", sourceDir), relativePath, startLine, lineCount)
}
