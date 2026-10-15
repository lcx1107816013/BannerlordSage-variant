package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/textfilecache"
)

// ─────────────────────────────────────────────────────────────────────────────
// text-file-cache parity (src/utils/text-file-cache.ts)
//
// 220 slice probes over 11 deliberately awkward files, plus the raw line splits. Expected
// values come from EXECUTING the TypeScript against the same on-disk files, which are
// committed, so both sides read identical bytes.
//
// The probe matrix exists to pin every clamping and splitting edge:
//   - startLine negative            -> clamped to 0
//   - lineCount 0 or negative       -> clamped to 1 (a zero-line request returns one line)
//   - startLine beyond EOF          -> empty text, startLine still reported
//   - hasMore computed from the CLAMPED end, not the request
//   - empty file                    -> exactly 1 line, and it is ""
//   - trailing newline              -> a phantom final empty line
//   - CRLF                          -> split on \r?\n, no stray \r
//   - lone CR                       -> NOT a separator
// ─────────────────────────────────────────────────────────────────────────────

type tfSliceShape struct {
	Text             string `json:"text"`
	StartLine        int    `json:"startLine"`
	EndLineExclusive int    `json:"endLineExclusive"`
	TotalLines       int    `json:"totalLines"`
	HasMore          bool   `json:"hasMore"`
}

type tfSliceProbe struct {
	File      string       `json:"file"`
	StartLine int          `json:"startLine"`
	LineCount int          `json:"lineCount"`
	OK        bool         `json:"ok"`
	Slice     tfSliceShape `json:"slice"`
	Error     string       `json:"error"`
}

type tfLineProbe struct {
	File  string   `json:"file"`
	OK    bool     `json:"ok"`
	Lines []string `json:"lines"`
	Error string   `json:"error"`
}

type tfMissing struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
	Note  string `json:"note"`
}

type tfLruProbe struct {
	File       string `json:"file"`
	Text       string `json:"text"`
	TotalLines int    `json:"totalLines"`
}

type tfFixtures struct {
	FileContents map[string]string `json:"fileContents"`
	Slices       []tfSliceProbe    `json:"slices"`
	Lines        []tfLineProbe     `json:"lines"`
	MissingFile  tfMissing         `json:"missingFile"`
	LRU          []tfLruProbe      `json:"lru"`
}

func loadTextFileFixtures(t *testing.T) (tfFixtures, string) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "textfile_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_textfile_fixtures.mjs", path, err)
	}
	var f tfFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Slices) == 0 || len(f.Lines) == 0 {
		t.Fatalf("fixtures look empty (slices=%d lines=%d); refusing to report success",
			len(f.Slices), len(f.Lines))
	}

	dir := filepath.Join("..", "..", "tools", "parity", "fixtures", "textfiles")

	// ★ Verify the corpus files on disk still match the fixture text before comparing
	// anything. If a file were edited, every expectation would silently become a
	// comparison against different bytes — a suite that still reports PASS while testing
	// nothing. This is the same class of defect the report fixtures hit three times.
	for name, want := range f.FileContents {
		got, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("corpus file missing (%s): %v\nregenerate the fixtures", name, err)
		}
		if string(got) != want {
			t.Fatalf("corpus file %s has changed on disk:\n  fixture = %q\n  disk    = %q\n"+
				"the expectations no longer describe these bytes; regenerate the fixtures",
				name, want, string(got))
		}
	}
	return f, dir
}

func TestTextFileSliceMatchesTypeScript(t *testing.T) {
	f, dir := loadTextFileFixtures(t)

	compared := 0
	for _, p := range f.Slices {
		if !p.OK {
			continue // TypeScript rejected; covered by the missing-file test below
		}
		full := filepath.Join(dir, p.File)

		// Cache state must not leak between probes: the TypeScript generator calls
		// clearTextFileCache() before each one, so the port is reset too. Otherwise a
		// probe could pass because of a previous probe's cache entry rather than because
		// the slice logic is right.
		textfilecache.ClearCache()

		got, err := textfilecache.ReadSlice(full, p.StartLine, p.LineCount)
		if err != nil {
			t.Errorf("ReadSlice(%s, %d, %d) errored: %v", p.File, p.StartLine, p.LineCount, err)
			continue
		}
		if got.Text != p.Slice.Text ||
			got.StartLine != p.Slice.StartLine ||
			got.EndLineExclusive != p.Slice.EndLineExclusive ||
			got.TotalLines != p.Slice.TotalLines ||
			got.HasMore != p.Slice.HasMore {
			t.Errorf("ReadSlice(%s, start=%d, count=%d)\n  go = %+v\n  ts = %+v",
				p.File, p.StartLine, p.LineCount, got, p.Slice)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no slice probes were compared")
	}
	t.Logf("compared %d slice probes against the TypeScript output", compared)
}

func TestTextFileLinesMatchTypeScript(t *testing.T) {
	f, dir := loadTextFileFixtures(t)
	compared := 0
	for _, p := range f.Lines {
		if !p.OK {
			continue
		}
		textfilecache.ClearCache()
		got, err := textfilecache.ReadLines(filepath.Join(dir, p.File))
		if err != nil {
			t.Errorf("ReadLines(%s) errored: %v", p.File, err)
			continue
		}
		if len(got) != len(p.Lines) {
			t.Errorf("ReadLines(%s): %d lines, want %d\n  go = %q\n  ts = %q",
				p.File, len(got), len(p.Lines), got, p.Lines)
			compared++
			continue
		}
		for i := range got {
			if got[i] != p.Lines[i] {
				t.Errorf("ReadLines(%s)[%d] = %q, want %q", p.File, i, got[i], p.Lines[i])
			}
		}
		compared++
	}
	t.Logf("compared %d line-split probes against the TypeScript output", compared)
}

// The missing-file case must FAIL, not return an empty slice. A silent empty result turns
// "the file is gone" into "the file is empty", which is exactly the sort of confident wrong
// answer the rest of this project exists to prevent.
func TestTextFileMissingFileIsAnError(t *testing.T) {
	f, dir := loadTextFileFixtures(t)
	if f.MissingFile.Note != "" {
		t.Fatalf("fixture says a missing file RESOLVED (%s); this test asserts it must not", f.MissingFile.Note)
	}
	textfilecache.ClearCache()
	if _, err := textfilecache.ReadSlice(filepath.Join(dir, "does-not-exist.txt"), 0, 10); err == nil {
		t.Error("ReadSlice on a missing file returned no error; it must reject like the TypeScript")
	}
	if _, err := textfilecache.ReadLines(filepath.Join(dir, "does-not-exist.txt")); err == nil {
		t.Error("ReadLines on a missing file returned no error; it must reject like the TypeScript")
	}
}

// Eviction must change performance, never results. Reading more than MaxCachedFiles files
// evicts the oldest, and the answer for an evicted file must be identical to a cached read.
func TestTextFileLruEvictionDoesNotChangeResults(t *testing.T) {
	f, dir := loadTextFileFixtures(t)
	if len(f.LRU) <= textfilecache.MaxCachedFiles {
		t.Fatalf("corpus has %d reads but the cache holds %d; eviction is not actually exercised",
			len(f.LRU), textfilecache.MaxCachedFiles)
	}

	textfilecache.ClearCache()
	compared := 0
	for _, p := range f.LRU {
		got, err := textfilecache.ReadSlice(filepath.Join(dir, p.File), 0, 2)
		if err != nil {
			t.Errorf("ReadSlice(%s) during LRU walk errored: %v", p.File, err)
			continue
		}
		if got.Text != p.Text || got.TotalLines != p.TotalLines {
			t.Errorf("ReadSlice(%s) after eviction pressure\n  go = (%q, total=%d)\n  ts = (%q, total=%d)",
				p.File, got.Text, got.TotalLines, p.Text, p.TotalLines)
		}
		compared++
	}
	t.Logf("compared %d reads across the cache limit (%d entries)", compared, textfilecache.MaxCachedFiles)
}
