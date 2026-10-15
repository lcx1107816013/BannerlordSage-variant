// Package tools ports the tool bodies from src/tools/. It holds the logic only; MCP
// registration lives with the server so a tool can be differentially tested without a
// transport in the way.
//
// The first two tools are here because their dependencies are verified: read_file is
// readTextFileSlice behind a PathSandbox, and both now have parity suites. list_directory
// needs only the sandbox.
package tools

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"blore/internal/report"
	"blore/internal/sandbox"
	"blore/internal/textfilecache"
)

// DefaultReadFileLines mirrors the TypeScript default lineCount of 400.
const DefaultReadFileLines = 400

// ReadFile mirrors readFile(sandbox, relativePath, startLine = 0, lineCount = 400) from
// src/tools/read-file.ts and returns the rendered report text.
//
// ★ FOUR DETAILS IN THE RENDERED REPORT ARE EASY TO "FIX" AND MUST NOT BE:
//
//  1. `resolved_path` carries the RELATIVE path, not the resolved absolute one. The key
//     name suggests otherwise; the TypeScript passes `relativePath`. Matching it matters
//     because downstream consumers parse this text.
//  2. `start_line_0based` and `requested_line_count` are the ORIGINAL request values,
//     before the slice clamps them. A negative startLine renders as negative.
//  3. `returned_line_count` is `endLineExclusive - startLine` using the ORIGINAL
//     startLine, so for startLine=-1 count=2 it reports 3 while the text holds 2 lines.
//     That is the TypeScript's arithmetic, not a rounding of the clamp.
//  4. `has_more` is the STRING "true"/"false" (the TypeScript passes a string), so it is
//     built with Text rather than Bool. Both would render the same today, but mirroring
//     the source means a future change to the renderer cannot make them diverge.
func ReadFile(box *sandbox.Sandbox, relativePath string, startLine, lineCount int) (string, error) {
	fullPath, err := box.ValidateAndResolve(relativePath)
	if err != nil {
		// The TypeScript catches everything here and throws one opaque message, without
		// the cause. Reproduced deliberately: the message is part of the contract, and
		// adding detail would change what callers see.
		return "", readFileError(relativePath)
	}

	slice, err := textfilecache.ReadSlice(fullPath, startLine, lineCount)
	if err != nil {
		return "", readFileError(relativePath)
	}

	hasMore := "false"
	if slice.HasMore {
		hasMore = "true"
	}

	return report.Render(
		"file_read",
		"query_relative_path",
		relativePath,
		[]report.Block{{
			Header: "file_slice",
			Fields: []report.Field{
				{Key: "resolved_path", Value: report.Text(relativePath)},
				{Key: "start_line_0based", Value: report.Number(float64(startLine))},
				{Key: "requested_line_count", Value: report.Number(float64(lineCount))},
				{Key: "returned_line_count", Value: report.Number(float64(slice.EndLineExclusive - startLine))},
				{Key: "end_line_exclusive_0based", Value: report.Number(float64(slice.EndLineExclusive))},
				{Key: "has_more", Value: report.Text(hasMore)},
			},
			MultilineFields: []report.Field{
				{Key: "file_content", Value: report.Text(slice.Text)},
			},
		}},
		nil,
	), nil
}

// readFileError builds the exact message the TypeScript throws.
func readFileError(relativePath string) error {
	return &toolError{"Failed to read file: " + relativePath}
}

// ListDirectory mirrors listDirectory(sandbox, relativePath = "") from
// src/tools/list-directory.ts.
//
// ★ THE SORT IS NOT Go's sort.Strings.
//
// The TypeScript uses `Array.prototype.sort()` with no comparator, which orders by UTF-16
// CODE UNIT. Go's sort.Strings orders by UTF-8 bytes. The two agree on ASCII and on all
// BMP characters, but they DISAGREE above the BMP:
//
//	"🎯"  U+1F3AF  UTF-16 D83C DF3F  -> sorts as 0xD83C
//	"\ue000"      UTF-16 E000        -> sorts as 0xE000
//
// so UTF-16 puts the emoji FIRST, while UTF-8 bytes would put it after (F0 9F 8E AF
// versus EE 80 80). jsSort below implements the UTF-16 ordering, and the fixture corpus
// contains exactly this pair so the difference is proven rather than assumed.
func ListDirectory(box *sandbox.Sandbox, relativePath string) (string, error) {
	fullPath, err := box.ValidateAndResolve(relativePath)
	if err != nil {
		return "", listDirectoryError(relativePath)
	}

	entries, err := os.ReadDir(fullPath)
	if err != nil {
		return "", listDirectoryError(relativePath)
	}

	// os.ReadDir already returns entries sorted by filename, but the ORDERING RULE is the
	// thing being mirrored, so the names are collected and re-sorted with the JS rule
	// rather than relying on a coincidentally similar implementation.
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			name += "/"
		}
		names = append(names, name)
	}
	jsSort(names)

	formatted := strings.Join(names, "\n")
	if formatted == "" {
		// Mirrors the TypeScript's `formatted || 'Directory is empty.'`.
		return "Directory is empty.", nil
	}
	return formatted, nil
}

func listDirectoryError(relativePath string) error {
	return &toolError{"Failed to list directory: " + relativePath}
}

// toolError is a plain error whose message the tool layer forwards verbatim.
type toolError struct{ msg string }

func (e *toolError) Error() string { return e.msg }

// jsSort orders strings by UTF-16 code unit, matching Array.prototype.sort() with no
// comparator.
//
// Go has no UTF-16 string type, so the comparison is done per rune with the encoding
// applied on the fly: a rune above U+FFFF is compared as its high surrogate first, which
// is what puts supplementary characters before U+E000-U+FFFF in JavaScript.
func jsSort(values []string) {
	sort.SliceStable(values, func(i, j int) bool {
		return jsLess(values[i], values[j])
	})
}

func jsLess(a, b string) bool {
	ra := []rune(a)
	rb := []rune(b)
	n := len(ra)
	if len(rb) < n {
		n = len(rb)
	}
	for k := 0; k < n; k++ {
		ca, cb := ra[k], rb[k]
		if ca == cb {
			continue
		}
		// Compare the UTF-16 encodings of the differing code point. For BMP runes this is
		// the rune itself; above the BMP it is the high surrogate, which is always less
		// than any BMP rune above U+D7FF and greater than those below.
		ua := utf16FirstUnit(ca)
		ub := utf16FirstUnit(cb)
		if ua != ub {
			return ua < ub
		}
		return ca < cb
	}
	return len(ra) < len(rb)
}

// utf16FirstUnit returns the first UTF-16 code unit of a rune, as JavaScript would see it.
func utf16FirstUnit(r rune) uint32 {
	if r <= 0xFFFF {
		return uint32(r)
	}
	return uint32(0xD800 + ((r - 0x10000) >> 10))
}

// FilepathJoin is exported for callers that need the same path construction the tools use.
func FilepathJoin(parts ...string) string { return filepath.Join(parts...) }
