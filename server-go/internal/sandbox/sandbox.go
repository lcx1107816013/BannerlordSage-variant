// Package sandbox is a faithful port of src/utils/path-sandbox.ts.
//
// It keeps both gates of the 2026-10-14 fix:
//  1. absolute paths (drive-letter, UNC) are rejected up front, because
//     Resolve(base, abs) would silently drop the base;
//  2. the relative-path result must not start with ".." nor be absolute.
package sandbox

import (
	"fmt"
	"path/filepath"
	"strings"
)

type Sandbox struct {
	basePath string
}

// New builds a sandbox. An absolute basePath is used as-is; a relative one is
// resolved against root (mirrors the TS constructor, which resolves against
// the repository root).
func New(root, basePath string) *Sandbox {
	var base string
	if filepath.IsAbs(basePath) {
		base = filepath.Clean(basePath)
	} else {
		base = filepath.Join(root, basePath)
	}
	return &Sandbox{basePath: base}
}

// BasePath returns the sandbox root.
func (s *Sandbox) BasePath() string { return s.basePath }

// ValidateAndResolve mirrors PathSandbox.validateAndResolve. On rejection the
// error message is byte-identical to the TS version:
//
//	Path escapes the sandbox root: "<relativePath>"
//
// Do NOT use %q here. Go's %q escapes backslashes, so a Windows path came out as
// "C:\Windows\win.ini" where the TS original produces "C:\Windows\win.ini".
// The strings are compared by callers and asserted in tests, so the escaping is
// a real fidelity break, not cosmetic. Plain quoted %s is what mirrors the
// template literal in path-sandbox.ts.
func (s *Sandbox) ValidateAndResolve(relativePath string) (string, error) {
	if filepath.IsAbs(relativePath) {
		return "", fmt.Errorf("Path escapes the sandbox root: \"%s\"", relativePath)
	}

	fullPath := filepath.Join(s.basePath, relativePath)

	rel, err := filepath.Rel(s.basePath, fullPath)
	if err != nil {
		return "", fmt.Errorf("Path escapes the sandbox root: \"%s\"", relativePath)
	}
	if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("Path escapes the sandbox root: \"%s\"", relativePath)
	}

	return fullPath, nil
}
