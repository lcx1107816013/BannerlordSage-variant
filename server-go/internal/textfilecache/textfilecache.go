// Package textfilecache is a faithful port of src/utils/text-file-cache.ts.
//
// It serves the line-slice reads behind the read_file tool. The observable contract is
// narrow but full of edges: a slice specifies a start line and a count, both are
// clamped, an out-of-range start yields empty text, and "has more" is computed from the
// clamped end rather than the request.
//
// The TypeScript caches up to 8 files, invalidated by (mtimeMs, size). The same scheme
// is used here. Two notes on fidelity:
//
//   - The cache key is the RESOLVED absolute path, matching `resolve(fullPath)`, so two
//     spellings of the same file share one entry.
//   - A rewrite that preserves BOTH mtime and size would serve stale content. That is
//     true of the TypeScript as well; it is a property of the design, not a porting
//     bug, and the parity corpus probes it so the behaviour is recorded rather than
//     assumed. Do not "improve" it into content hashing — that would diverge.
package textfilecache

import (
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// MaxCachedFiles mirrors MAX_CACHED_FILES.
const MaxCachedFiles = 8

// defaultLineCount mirrors the TypeScript default of 400.
const defaultLineCount = 400

// Slice is the TypeScript TextSlice shape.
type Slice struct {
	Text             string
	StartLine        int
	EndLineExclusive int
	TotalLines       int
	HasMore          bool
}

type cachedFile struct {
	fullPath string
	mtimeMs  int64
	size     int64
	lines    []string
}

var (
	mu sync.Mutex
	// cache + order implement an LRU. Go maps do not preserve insertion order, so the
	// order is tracked explicitly; with at most 8 entries the O(n) touch is free.
	cache map[string]*cachedFile
	order []string
)

func init() {
	cache = make(map[string]*cachedFile)
}

// ClearCache mirrors clearTextFileCache().
func ClearCache() {
	mu.Lock()
	defer mu.Unlock()
	cache = make(map[string]*cachedFile)
	order = nil
}

// ReadSlice mirrors readTextFileSlice(fullPath, startLine = 0, lineCount = 400).
//
// Returns an error where the TypeScript would reject: a missing or unreadable file
// propagates, because the caller's contract is a thrown error, and silently returning an
// empty slice would turn "file is gone" into "file is empty".
func ReadSlice(fullPath string, startLine, lineCount int) (Slice, error) {
	entry, err := getCachedTextFile(fullPath)
	if err != nil {
		return Slice{}, err
	}

	// ★ Clamping mirrors the TypeScript exactly: max(0, startLine) and
	// max(1, lineCount). A request of 0 lines still returns one, which is surprising but
	// is the documented behaviour and is pinned by the corpus.
	safeStart := startLine
	if safeStart < 0 {
		safeStart = 0
	}
	safeCount := lineCount
	if safeCount < 1 {
		safeCount = 1
	}

	endLineExclusive := safeStart + safeCount
	if endLineExclusive > len(entry.lines) {
		endLineExclusive = len(entry.lines)
	}

	// A start beyond EOF must not panic on the slice below: clamp it for the bounds
	// expression while still reporting the requested (already non-negative) value, which
	// is what the TypeScript does — it reports safeStart unchanged and relies on
	// Array.slice tolerating an overshoot.
	from := safeStart
	if from > len(entry.lines) {
		from = len(entry.lines)
	}
	text := strings.Join(entry.lines[from:endLineExclusive], "\n")

	return Slice{
		Text:             text,
		StartLine:        safeStart,
		EndLineExclusive: endLineExclusive,
		TotalLines:       len(entry.lines),
		HasMore:          endLineExclusive < len(entry.lines),
	}, nil
}

// ReadLines mirrors readTextFileLines().
func ReadLines(fullPath string) ([]string, error) {
	entry, err := getCachedTextFile(fullPath)
	if err != nil {
		return nil, err
	}
	out := make([]string, len(entry.lines))
	copy(out, entry.lines)
	return out, nil
}

func getCachedTextFile(fullPath string) (*cachedFile, error) {
	resolved := resolvePath(fullPath)
	info, err := os.Stat(resolved)
	if err != nil {
		return nil, err
	}
	mtimeMs := info.ModTime().UnixNano() / 1_000_000
	size := info.Size()

	mu.Lock()
	if cached, ok := cache[resolved]; ok && cached.mtimeMs == mtimeMs && cached.size == size {
		touchLocked(resolved, cached)
		mu.Unlock()
		return cached, nil
	}
	mu.Unlock()

	raw, err := os.ReadFile(resolved)
	if err != nil {
		return nil, err
	}
	entry := &cachedFile{
		fullPath: resolved,
		mtimeMs:  mtimeMs,
		size:     size,
		lines:    splitLines(string(raw)),
	}

	mu.Lock()
	touchLocked(resolved, entry)
	mu.Unlock()
	return entry, nil
}

func touchLocked(key string, value *cachedFile) {
	cache[key] = value
	// Move to the most-recently-used end.
	for i, k := range order {
		if k == key {
			order = append(order[:i], order[i+1:]...)
			break
		}
	}
	order = append(order, key)

	for len(order) > MaxCachedFiles {
		oldest := order[0]
		order = order[1:]
		delete(cache, oldest)
	}
}

// resolvePath mirrors `resolve(fullPath)`: absolute and cleaned, so two spellings of one
// file share a cache entry.
func resolvePath(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return filepath.Clean(abs)
}

// splitLines mirrors the JS `raw.split(/\r?\n/)`.
//
// Note the consequence the corpus pins: a trailing newline yields a final EMPTY line, and
// an empty file yields exactly one empty line (not zero). This is the same rule the
// report package implements; the two are kept in sync by the same test corpus rather than
// by sharing code, so neither package drags the other in.
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}

// DefaultLineCount exposes the TypeScript default so callers need not repeat it.
func DefaultLineCount() int { return defaultLineCount }
