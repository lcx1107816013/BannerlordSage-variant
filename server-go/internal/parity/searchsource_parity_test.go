package parity_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"blore/internal/tools"
)

// ─────────────────────────────────────────────────────────────────────────────
// search_source parity (src/tools/search-source.ts)
//
// ★ ORDER IS COMPARED AS A SET, AND HERE IS EXACTLY WHY.
//
// The tool shells out to ripgrep WITHOUT --sort, so ripgrep emits matches in worker-completion
// order, which is scheduling-dependent. Measured, not assumed: regenerating the fixtures three
// times changed the ORDER of the [result_N] blocks every time, on a corpus with only six
// matches. So byte-for-byte comparison is impossible for this tool at any corpus size, and a
// suite that demanded it would fail for reasons unrelated to the port.
//
// What IS compared exactly:
//   - the header lines: report_type, query_text, result_count
//   - every top-level field, in order, byte for byte
//   - the NUMBER of blocks
//   - each block's full rendered text, including its result_label, field order, path
//     normalisation, trailing-whitespace handling and submatch counts
//
// What is NOT compared:
//   - the order of the blocks, because the upstream tool does not determine it
//
// Stating that limit is the point. A suite that compared sorted sets without saying so would
// look like it verified ordering, and one that compared bytes would be red for no reason. The
// nondeterminism itself is recorded as a property of the capability (ledger F22), because a
// client of this tool cannot rely on result order either.
// ─────────────────────────────────────────────────────────────────────────────

type ssCase struct {
	Query         string `json:"query"`
	CaseSensitive bool   `json:"caseSensitive"`
	FilePattern   string `json:"filePattern"`
	OK            bool   `json:"ok"`
	Text          string `json:"text"`
	Error         string `json:"error"`
}

type ssFixtures struct {
	RipgrepVersion string   `json:"ripgrepVersion"`
	CorpusFiles    []string `json:"corpusFiles"`
	Results        []ssCase `json:"results"`
}

// renderedReport is a rendered report split into its comparable parts.
type renderedReport struct {
	Header string   // everything up to and including the blank line after the top fields
	Blocks []string // each block's text, starting at its [result_N] line
}

// splitRenderedReport splits on the `[result_N]` markers the renderer emits.
func splitRenderedReport(text string) renderedReport {
	lines := strings.Split(text, "\n")
	var out renderedReport
	var current []string
	inBlock := false

	for _, line := range lines {
		isMarker := strings.HasPrefix(line, "[result_") && strings.HasSuffix(line, "]")
		if isMarker {
			if inBlock {
				out.Blocks = append(out.Blocks, strings.Join(current, "\n"))
			}
			current = []string{line}
			inBlock = true
			continue
		}
		if inBlock {
			current = append(current, line)
			continue
		}
		out.Header += line + "\n"
	}
	if inBlock {
		out.Blocks = append(out.Blocks, strings.Join(current, "\n"))
	}
	return out
}

func loadSearchSourceFixtures(t *testing.T) ssFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "searchsource_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_searchsource_fixtures.mjs", path, err)
	}
	var f ssFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Results) == 0 {
		t.Fatal("fixtures contain no cases; refusing to report success")
	}

	// ★ Confirm the corpus the fixtures describe is present. The fixtures were produced against
	// fixtures/ripgrep-corpus; if that directory were regenerated with different files, every
	// expectation would describe a corpus that no longer exists while the suite still passed.
	corpusDir := filepath.Join("..", "..", "tools", "parity", "fixtures", "ripgrep-corpus")
	for _, rel := range f.CorpusFiles {
		full := filepath.Join(corpusDir, filepath.FromSlash(rel))
		if _, err := os.Stat(full); err != nil {
			t.Fatalf("corpus file missing: %s (%v)\nregenerate the fixtures", full, err)
		}
	}
	return f
}

func TestSearchSourceMatchesTypeScript(t *testing.T) {
	f := loadSearchSourceFixtures(t)
	sandbox := filepath.Join("..", "..", "tools", "parity", "fixtures", "ripgrep-corpus")

	compared := 0
	orderVaried := 0

	for _, c := range f.Results {
		if !c.OK {
			t.Errorf("the TypeScript threw for query %q: %s", c.Query, c.Error)
			continue
		}

		got, err := tools.SearchSource(context.Background(), sandbox, c.Query, c.CaseSensitive, c.FilePattern)
		if err != nil {
			t.Errorf("SearchSource(%q, caseSensitive=%v, pattern=%q) errored: %v",
				c.Query, c.CaseSensitive, c.FilePattern, err)
			continue
		}

		want := splitRenderedReport(c.Text)
		have := splitRenderedReport(got)

		label := formattedLabel(c)

		// The header carries report_type, query_text, result_count and every top-level field.
		// Its ORDER is produced by the renderer, not by ripgrep, so it must match exactly.
		if have.Header != want.Header {
			t.Errorf("%s: header differs\n--- go ---\n%s--- ts ---\n%s", label, have.Header, want.Header)
		}

		if len(have.Blocks) != len(want.Blocks) {
			t.Errorf("%s: block count differs: go=%d ts=%d\n--- go ---\n%s\n--- ts ---\n%s",
				label, len(have.Blocks), len(want.Blocks), got, c.Text)
			continue
		}

		// Compare as sets. Any difference in content, field order inside a block, path form or
		// whitespace still fails here — only the block ORDER is excused, because it is not
		// reproducible.
		//
		// ★ `result_label: match_N` is DROPPED before comparing, and the reason matters: the
		// label is assigned BY POSITION (`match_${index + 1}`), so when ripgrep returns matches
		// in a different order the same file legitimately carries a different label. Comparing
		// the labels as content would report a difference that is not one. They are checked
		// separately below, where being sequential is the actual claim.
		goSorted := blockContents(have.Blocks)
		tsSorted := blockContents(want.Blocks)
		if !sameOrder(goSorted, tsSorted) {
			orderVaried++
		}
		sort.Strings(goSorted)
		sort.Strings(tsSorted)
		if strings.Join(goSorted, "\x00") != strings.Join(tsSorted, "\x00") {
			t.Errorf("%s: block contents differ (as sets)\n--- go ---\n%s\n--- ts ---\n%s",
				label, got, c.Text)
		}

		// The labels must be match_1..match_N, in order, in both.
		assertSequentialLabels(t, "go", have.Blocks)
		assertSequentialLabels(t, "ts", want.Blocks)

		compared++
	}

	if compared == 0 {
		t.Fatal("no search_source cases were compared")
	}
	t.Logf("compared %d search_source reports against the TypeScript output (%d differed in block order only)",
		compared, orderVaried)
}

func formattedLabel(c ssCase) string {
	label := "query=" + c.Query
	label += " caseSensitive=" + boolStr(c.CaseSensitive)
	if c.FilePattern != "" {
		label += " pattern=" + c.FilePattern
	}
	return label
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// blockContents returns each block with its two POSITIONAL lines removed: the `[result_N]`
// marker and the `result_label: match_N` line.
//
// Both are derived from the block's index (`result_${i+1}` and `match_${i+1}`), so they are not
// content. When ripgrep returns the same matches in a different order, the same file legitimately
// carries a different number; keeping either line would report a difference that does not exist,
// while dropping them loses nothing because the numbering is checked separately — the marker
// sequence is part of the render, and assertSequentialLabels verifies match_1..match_N in order.
func blockContents(blocks []string) []string {
	out := make([]string, 0, len(blocks))
	for _, b := range blocks {
		var kept []string
		for _, line := range strings.Split(b, "\n") {
			if strings.HasPrefix(line, "result_label: ") {
				continue
			}
			if strings.HasPrefix(line, "[result_") && strings.HasSuffix(line, "]") {
				continue
			}
			kept = append(kept, line)
		}
		// The report ends with a newline, so whichever block happens to be LAST carries a
		// trailing "\n" that the others do not. Since the block order is not reproducible, that
		// newline lands on a different block each run and would show up as a difference that does
		// not exist. It is safe to drop trailing newlines from a block: `line_text` comes from
		// ripgrep's `lines.text` after a trimEnd, so it cannot itself end in a newline — a
		// trailing newline here can only be the report's separator.
		out = append(out, strings.TrimRight(strings.Join(kept, "\n"), "\n"))
	}
	return out
}

// assertSequentialLabels checks that the blocks carry result_label match_1..match_N in order.
func assertSequentialLabels(t *testing.T, side string, blocks []string) {
	t.Helper()
	for i, b := range blocks {
		want := "result_label: match_" + itoaForTest(i+1)
		if !strings.Contains(b, want+"\n") {
			t.Errorf("%s: block %d does not carry %q", side, i+1, want)
			return
		}
	}
}

// sameOrder reports whether two string slices are in the same order.
func sameOrder(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// TestSearchSourceNoMatchIsNotAnError pins the exit-code rule that a port would plausibly get
// wrong: ripgrep exits 1 when it finds nothing, and the tool treats that as a normal empty
// result. Folding it into an error would make every empty search look like a crash.
func TestSearchSourceNoMatchIsNotAnError(t *testing.T) {
	f := loadSearchSourceFixtures(t)
	sandbox := filepath.Join("..", "..", "tools", "parity", "fixtures", "ripgrep-corpus")

	var found bool
	for _, c := range f.Results {
		if !c.OK || !strings.Contains(c.Text, "result_count: 0") {
			continue
		}
		found = true
		got, err := tools.SearchSource(context.Background(), sandbox, c.Query, c.CaseSensitive, c.FilePattern)
		if err != nil {
			t.Errorf("a query with no matches was reported as an error: %v", err)
			continue
		}
		if !strings.Contains(got, "total_matches_found: 0") {
			t.Errorf("expected total_matches_found: 0 for %q:\n%s", c.Query, got)
		}
		if !strings.Contains(got, "truncated: false") {
			t.Errorf("expected truncated: false for %q:\n%s", c.Query, got)
		}
	}
	if !found {
		t.Fatal("the fixtures contain no zero-match case; the exit-code rule is untested")
	}
}

// TestSearchSourcePathNormalisation pins the two-step path transformation. Both directions are
// needed: the leading `./` strip must happen on the ORIGINAL separators, and backslashes must
// become forward slashes. A single-pass regex would satisfy neither on Windows.
func TestSearchSourcePathNormalisation(t *testing.T) {
	cases := []struct{ in, want string }{
		{"./src/Api/Handler.cs", "src/Api/Handler.cs"},
		{".\\src\\Api\\Handler.cs", "src/Api/Handler.cs"},
		{"src\\Api\\Handler.cs", "src/Api/Handler.cs"},
		{"src/Api/Handler.cs", "src/Api/Handler.cs"},
		// A path that merely CONTAINS a dot must not have it stripped.
		{"./src/./odd.cs", "src/./odd.cs"},
	}
	for _, c := range cases {
		if got := tools.NormalizeRipgrepPath(c.in); got != c.want {
			t.Errorf("normalise(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestSearchSourceLineTextTrailingOnly pins trimEnd semantics: leading indentation is part of a
// code search result and must survive, while trailing whitespace is removed.
func TestSearchSourceLineTextTrailingOnly(t *testing.T) {
	sample := `{"type":"match","data":{"path":{"text":"a.cs"},"line_number":7,` +
		`"lines":{"text":"\t  indented code   \t\n"},"submatches":[{}]}}`
	got := tools.ParseRipgrepJSON(sample)
	if len(got.Matches) != 1 {
		t.Fatalf("expected 1 match, got %d", len(got.Matches))
	}
	want := "\t  indented code"
	if got.Matches[0].LineText != want {
		t.Errorf("line text = %q, want %q (leading whitespace must survive)", got.Matches[0].LineText, want)
	}
	if !got.Matches[0].LineNumberOK || got.Matches[0].LineNumber != 7 {
		t.Errorf("line number = %d (ok=%v), want 7", got.Matches[0].LineNumber, got.Matches[0].LineNumberOK)
	}
}

// TestSearchSourceParserEdgeCases pins the rules a plausible rewrite would break. Each case is
// a shape that occurs in real ripgrep output or in the guard the TypeScript writes.
func TestSearchSourceParserEdgeCases(t *testing.T) {
	// Non-match events must be ignored, invalid JSON skipped rather than fatal, and a match
	// with an empty path must contribute to NEITHER the match list NOR the file count.
	stdout := strings.Join([]string{
		`{"type":"begin","data":{"path":{"text":"./a.cs"}}}`,
		`{"type":"match","data":{"path":{"text":"./a.cs"},"line_number":1,"lines":{"text":"x"},"submatches":[{}]}}`,
		`not json at all`,
		``,
		`{"type":"match","data":{"path":{"text":""},"line_number":2,"lines":{"text":"empty path"},"submatches":[{}]}}`,
		`{"type":"match","data":{"line_number":3,"lines":{"text":"no path"}}}`,
		`{"type":"match","data":{"path":{"text":"./b.cs"},"lines":{"text":"no line number"},"submatches":[]}}`,
		`{"type":"summary","data":{"elapsed_total":{"secs":0,"nanos":1}}}`,
	}, "\n")

	got := tools.ParseRipgrepJSON(stdout)

	if len(got.Matches) != 2 {
		t.Fatalf("expected 2 matches, got %d: %+v", len(got.Matches), got.Matches)
	}
	if got.UniqueFileCount != 2 {
		t.Errorf("unique file count = %d, want 2 (empty and missing paths must not count)",
			got.UniqueFileCount)
	}
	// The line number is ABSENT, so it must stay distinguishable from zero.
	if got.Matches[1].LineNumberOK {
		t.Errorf("a match with no line_number must not report one (got %d)", got.Matches[1].LineNumber)
	}
	// The path still normalised, and the submatch count fell back to 0 for an empty array.
	if got.Matches[1].FilePath != "b.cs" {
		t.Errorf("path = %q, want b.cs", got.Matches[1].FilePath)
	}
	if got.Matches[1].SubmatchCount != 0 {
		t.Errorf("submatch count = %d, want 0", got.Matches[1].SubmatchCount)
	}
}

// TestSearchSourceTruncationIsCounted pins the difference between total matches and returned
// matches: unique_file_count counts ALL matches before truncation, so it may exceed the number
// of blocks rendered.
func TestSearchSourceTruncationIsCounted(t *testing.T) {
	// ★ 600, not 130. This test previously used 130 matches, which stopped truncating the moment
	// the limit moved from 120 to 500 — it would have kept passing while verifying nothing.
	// The count now has to exceed the limit with margin.
	const total = 600
	var lines []string
	for i := 0; i < total; i++ {
		lines = append(lines, `{"type":"match","data":{"path":{"text":"./f.cs"},"line_number":`+
			itoaForTest(i+1)+`,"lines":{"text":"hit"},"submatches":[{}]}}`)
	}
	parsed := tools.ParseRipgrepJSON(strings.Join(lines, "\n"))
	if len(parsed.Matches) != total {
		t.Fatalf("expected %d parsed matches, got %d", total, len(parsed.Matches))
	}
	if parsed.UniqueFileCount != 1 {
		t.Errorf("unique file count = %d, want 1", parsed.UniqueFileCount)
	}

	// Now drive the renderer through the injected runner so no ripgrep is needed.
	runner := func(_ context.Context, _ []string) (string, string, int, error) {
		return strings.Join(lines, "\n"), "", 0, nil
	}
	out, err := tools.SearchSourceWithRunner(context.Background(), ".", []string{"-e", "hit", "."},
		runner, "hit", false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, want := range []string{
		"total_matches_found: 600",
		"matches_returned: 500",
		"match_limit: 500",
		"truncated: true",
		"result_count: 500",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("expected %q in the report:\n%s", want, out)
		}
	}
}

// TestSearchSourceMissingLineNumberRendersAsUnknown pins the renderer half of the null
// line-number rule, which the parser test alone does NOT cover.
//
// Found by mutation testing: replacing the renderer's `report.Null()` with `report.Number(0)`
// left the whole suite GREEN, because every fixture case had a line number. That is a real gap —
// "unknown" and "0" are different claims, and 0 asserts a line that cannot exist. This test
// drives the renderer through the injected runner, so it needs no ripgrep.
func TestSearchSourceMissingLineNumberRendersAsUnknown(t *testing.T) {
	// One match WITH a line number and one WITHOUT, so the difference is visible side by side.
	stdout := strings.Join([]string{
		`{"type":"match","data":{"path":{"text":"./with.cs"},"line_number":12,"lines":{"text":"a"},"submatches":[{}]}}`,
		`{"type":"match","data":{"path":{"text":"./without.cs"},"lines":{"text":"b"},"submatches":[{}]}}`,
	}, "\n")

	runner := func(_ context.Context, _ []string) (string, string, int, error) {
		return stdout, "", 0, nil
	}
	out, err := tools.SearchSourceWithRunner(context.Background(), ".", []string{"-e", "x", "."},
		runner, "x", false, "")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !strings.Contains(out, "line_number_1based: 12") {
		t.Errorf("the present line number must render as 12:\n%s", out)
	}
	if !strings.Contains(out, "line_number_1based: unknown") {
		t.Errorf("an absent line number must render as unknown, not as a number:\n%s", out)
	}
	if strings.Contains(out, "line_number_1based: 0") {
		t.Errorf("an absent line number was rendered as 0, which asserts a line that cannot exist:\n%s", out)
	}
}

func itoaForTest(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
