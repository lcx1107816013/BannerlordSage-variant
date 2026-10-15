package tools

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"

	"blore/internal/report"
)

// maxMatchResults mirrors MAX_MATCH_RESULTS in src/tools/search-source.ts.
//
// ── ★ RAISED FROM 120 TO 500 — A DELIBERATE BEHAVIOUR CHANGE ──────────────────────────────
//
// This is the ONE place where this port intentionally does not match the code it was ported
// from, so the reasoning is recorded here rather than left to be rediscovered.
//
// The problem (ledger F22): ripgrep runs without --sort, so matches arrive in worker-completion
// order, and the tool truncates to the first N. Measured on our own BlBridge C# source, a
// 357-match query returned a DIFFERENT 120-match subset on all five runs. A limit that silently
// discards results in an unstable order makes the tool unusable for any query that exceeds it.
//
// 500 was chosen because it covers the case that was actually observed: the 357-match query now
// fits inside the limit and is therefore returned IN FULL and is stable. It is not a round number
// for its own sake; it is the smallest round value comfortably above the measured failure.
//
// The cost was measured rather than guessed. A rendered match block is about 182 characters, or
// roughly 46 tokens, so a full 500-block response is about 23,000 tokens — large, and the reason
// this is not raised further. Most queries return far fewer and cost far less.
//
// ★ AND THE LIMIT IS STILL A LIMIT. This does NOT make the tool deterministic in general: a query
// matching more than 500 times still returns an arbitrary, unstable 500. Raising it pushes the
// boundary out; it does not remove it. Removing it means either --sort (which changes WHICH
// results come back, a divergence this project refuses) or returning everything (which is
// bounded only by the corpus). So the honest statement is: below 500 results are now complete and
// stable, above 500 they are still arbitrary — and the `truncated` field says which case you are in.
const maxMatchResults = 500

// RipgrepMatch is one parsed `type: "match"` event from ripgrep's --json stream.
type RipgrepMatch struct {
	FilePath      string
	LineNumber    int  // 0 means the TypeScript stored null; see LineNumberIsNull
	LineNumberOK  bool // false == the TS value was null
	LineText      string
	SubmatchCount int
}

// RipgrepResult is what parseRipgrepJSON extracts from a ripgrep run.
type RipgrepResult struct {
	Matches         []RipgrepMatch
	UniqueFileCount int
}

// SearchSource mirrors searchSource(sandbox, query, caseSensitive, filePattern) from
// src/tools/search-source.ts and returns the rendered report text.
//
// ── ★ THE ORDERING HAZARD, WHICH IS A PROPERTY OF THE TOOL AND NOT OF THIS PORT ──────────
//
// The TypeScript invokes ripgrep WITHOUT --sort, so ripgrep emits matches in completion order,
// which depends on how its worker threads happen to be scheduled. Measured on this machine, on
// a corpus of five matching files, ten consecutive identical runs produced a stable order
// (probably because the corpus was small enough to be handled by one worker); on a larger
// corpus the order is definitely not stable.
//
// That matters much more than it looks, because the tool TRUNCATES to the first 120 matches.
// Measured against our own BlBridge C# source, a query with 357 matches returned a DIFFERENT
// 120-match subset on all five runs (five distinct digests of the first 120 file names).
//
// So `search_source`, exactly as it exists upstream and before any porting, returns a
// nondeterministic subset of its results whenever a query matches more than 120 times. That is
// recorded in the capability ledger rather than smoothed over, because a port cannot fix it
// without diverging: the fix (`--sort path`) would change which results the tool returns.
//
// The consequence for this port's parity suite: byte-for-byte comparison is only meaningful
// on queries whose match count is well under the limit, so the fixtures use those. That is a
// deliberate, stated limitation rather than a suite that quietly passes on easy cases only.
//
// ── WHY THE RUNNER IS A PARAMETER ────────────────────────────────────────────────────────
//
// The executable is injected so the parser can be exercised on recorded ripgrep output. A
// parity suite that had to shell out to ripgrep would be testing the machine's ripgrep
// version as much as this code.
func SearchSource(ctx context.Context, basePath, query string, caseSensitive bool, filePattern string) (string, error) {
	args := []string{"--json", "--line-number", "--color", "never"}
	if caseSensitive {
		args = append(args, "-s")
	} else {
		args = append(args, "-i")
	}
	if filePattern != "" {
		args = append(args, "-g", filePattern)
	}
	args = append(args, "-e", query, ".")
	return searchSourceWith(ctx, basePath, args, query, caseSensitive, filePattern)
}

// SearchSourceWithRunner is the injection point used by tests.
func SearchSourceWithRunner(ctx context.Context, basePath string, args []string, run RipgrepRunner,
	query string, caseSensitive bool, filePattern string) (string, error) {
	return runAndRender(ctx, args, run, query, caseSensitive, filePattern)
}

// searchSourceWith builds the real runner for a sandbox and renders the report.
func searchSourceWith(ctx context.Context, basePath string, args []string, query string,
	caseSensitive bool, filePattern string) (string, error) {
	return runAndRender(ctx, args, defaultRipgrepRunner(basePath), query, caseSensitive, filePattern)
}

func runAndRender(ctx context.Context, args []string, run RipgrepRunner, query string,
	caseSensitive bool, filePattern string) (string, error) {
	stdout, stderr, exitCode, err := run(ctx, args)
	if err != nil {
		return "", err
	}

	// Mirror the TypeScript guard exactly: exit code 0 (matches found) and 1 (no matches) are
	// both accepted; anything else is an error. Treating 1 as a failure would break every
	// query that legitimately finds nothing.
	if exitCode != 0 && exitCode != 1 {
		detail := strings.TrimSpace(stderr)
		if detail == "" {
			detail = "exit code " + itoa(exitCode)
		}
		return "", &RipgrepError{Detail: detail}
	}

	parsed := ParseRipgrepJSON(stdout)

	limit := len(parsed.Matches)
	truncated := false
	if limit > maxMatchResults {
		limit = maxMatchResults
		truncated = true
	}

	blocks := make([]report.Block, 0, limit)
	for i := 0; i < limit; i++ {
		m := parsed.Matches[i]
		// ★ line_number_1based is null when ripgrep did not report a number, and the report
		// renders null as "unknown". Storing 0 here would print "0", which is a different
		// claim — it would assert the match is on a line that cannot exist.
		var lineNumber report.Scalar
		if m.LineNumberOK {
			lineNumber = report.Number(float64(m.LineNumber))
		} else {
			lineNumber = report.Null()
		}
		blocks = append(blocks, report.Block{
			Header: "match_" + itoa(i+1),
			Fields: []report.Field{
				{Key: "file_path", Value: report.Text(m.FilePath)},
				{Key: "line_number_1based", Value: lineNumber},
				{Key: "submatch_count", Value: report.Number(float64(m.SubmatchCount))},
			},
			MultilineFields: []report.Field{{Key: "line_text", Value: report.Text(m.LineText)}},
		})
	}

	var filePatternValue string
	if filePattern != "" {
		filePatternValue = filePattern
	} else {
		filePatternValue = "(none)"
	}

	var caseSensitiveValue string
	if caseSensitive {
		caseSensitiveValue = "true"
	} else {
		caseSensitiveValue = "false"
	}

	// The top fields are in the SAME order as the TypeScript, which is observable output.
	topFields := []report.Field{
		{Key: "case_sensitive", Value: report.Text(caseSensitiveValue)},
		{Key: "file_pattern", Value: report.Text(filePatternValue)},
		{Key: "unique_file_count", Value: report.Number(float64(parsed.UniqueFileCount))},
		{Key: "total_matches_found", Value: report.Number(float64(len(parsed.Matches)))},
		{Key: "matches_returned", Value: report.Number(float64(limit))},
		{Key: "match_limit", Value: report.Number(float64(maxMatchResults))},
		{Key: "truncated", Value: report.Text(boolText(truncated))},
	}

	return report.Render("source_search", "query_text", query, blocks, topFields), nil
}

func boolText(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

// RipgrepError mirrors the TypeScript thrown Error message so a caller sees the same text.
type RipgrepError struct{ Detail string }

func (e *RipgrepError) Error() string {
	return "ripgrep failed while searching source: " + e.Detail
}

// RipgrepRunner runs ripgrep with the given args and returns stdout, stderr and the exit code.
type RipgrepRunner func(ctx context.Context, args []string) (stdout, stderr string, exitCode int, err error)

// defaultRipgrepRunner runs the real ripgrep in the sandbox base directory.
//
// ★ A non-zero exit code is NOT returned as an error here. ripgrep exits 1 to mean "no
// matches", which is a normal result the caller must interpret, so folding it into `err` would
// make an empty search look like a crash. Only a genuine execution failure (binary missing,
// permission denied) is an error.
func defaultRipgrepRunner(basePath string) RipgrepRunner {
	return func(ctx context.Context, args []string) (string, string, int, error) {
		cmd := exec.CommandContext(ctx, "rg", args...)
		cmd.Dir = basePath
		var out, errBuf strings.Builder
		cmd.Stdout = &out
		cmd.Stderr = &errBuf
		err := cmd.Run()
		if err != nil {
			if _, ok := err.(*exec.ExitError); !ok {
				return "", "", 0, err
			}
			return out.String(), errBuf.String(), cmd.ProcessState.ExitCode(), nil
		}
		return out.String(), errBuf.String(), 0, nil
	}
}

// ParseRipgrepJSON mirrors parseRipgrepJson(stdoutText) exactly.
//
// The rules that matter, each of which a reasonable-looking rewrite would break:
//
//   - Lines are split on /\r?\n/ and each is trimmed; blank lines are skipped. A line that is
//     not valid JSON is SKIPPED, not an error — ripgrep writes diagnostic lines into the same
//     stream, so treating one as fatal would break normal runs.
//   - Only `type: "match"` events count. `begin`, `end`, `summary` and `context` are ignored,
//     which is why a naive "count the lines" port would over-report.
//   - A match event whose path is missing, non-string or EMPTY is skipped, and — importantly —
//     is skipped BEFORE the unique-file set is updated, so such an event contributes nothing
//     to either the match list or the file count.
//   - The path is normalised: a leading `./` or `.\` is stripped, then every backslash becomes
//     a forward slash. Order matters: normalising before stripping would leave the separator
//     inconsistent on Windows.
//   - `line_number` is kept as null unless it is a JSON number. `0` is a valid number and is
//     therefore preserved, so "missing" and "zero" stay distinguishable.
//   - `lines.text` is `trimEnd()`ed — trailing whitespace only, never the leading side, which
//     is why the indentation in `line_text` is preserved.
//   - `submatch_count` falls back to 0 when `submatches` is absent or not an array.
//   - `unique_file_count` counts DISTINCT normalised paths across ALL matches, before the
//     120-item truncation — so it can legitimately exceed `matches_returned`.
func ParseRipgrepJSON(stdoutText string) RipgrepResult {
	matches := make([]RipgrepMatch, 0)
	uniqueFiles := map[string]struct{}{}

	for _, line := range splitRipgrepLines(stdoutText) {
		trimmed := report.TrimJS(line)
		if trimmed == "" {
			continue
		}

		var event map[string]any
		if err := json.Unmarshal([]byte(trimmed), &event); err != nil {
			continue
		}
		if kind, ok := event["type"].(string); !ok || kind != "match" {
			continue
		}

		data, _ := event["data"].(map[string]any)
		filePath := jsonPathText(data)
		if filePath == "" {
			continue
		}

		normalizedPath := NormalizeRipgrepPath(filePath)

		uniqueFiles[normalizedPath] = struct{}{}

		m := RipgrepMatch{FilePath: normalizedPath}

		// ★ Only a JSON number is accepted for the line number. Note this checks the decoded
		// type rather than a cast: JSON numbers arrive as float64, and 0 is a legitimate value
		// that must not be confused with "absent".
		if data != nil {
			if raw, ok := data["line_number"]; ok {
				if num, ok := raw.(float64); ok {
					m.LineNumber = int(num)
					m.LineNumberOK = true
				}
			}
			if lines, ok := data["lines"].(map[string]any); ok {
				if text, ok := lines["text"].(string); ok {
					m.LineText = report.TrimEndJS(text)
				}
			}
			if sub, ok := data["submatches"].([]any); ok {
				m.SubmatchCount = len(sub)
			}
		}

		matches = append(matches, m)
	}

	return RipgrepResult{Matches: matches, UniqueFileCount: len(uniqueFiles)}
}

// jsonPathText mirrors `data.path?.text` followed by the typeof/length guard.
//
// ★ It must NOT use a `startsWith("./")` test among others: the check is that the string is
// non-empty, and a UTF-16 length check is equivalent to a Go one only for strings without
// surrogate pairs. A path made only of a supplementary-plane character would have JS length 2
// and Go len 4 — but since the test is only `length === 0`, both agree. Recorded so nobody
// "optimises" it later into a byte-length comparison with different bounds.
func jsonPathText(data map[string]any) string {
	if data == nil {
		return ""
	}
	path, ok := data["path"].(map[string]any)
	if !ok {
		return ""
	}
	text, ok := path["text"].(string)
	if !ok {
		return ""
	}
	return text
}

// normalizeRipgrepPath mirrors `filePath.replace(/^[.][\\/]/, ”).replaceAll('\\\\', '/')`.
//
// The leading-separator strip happens FIRST, on the original separators, and only then are
// backslashes converted. Doing it in the other order would still work for the `./` form but
// would silently fail for a path beginning `.\\` on a platform where the regex no longer sees
// a backslash — which is precisely the Windows case this exists for.
func NormalizeRipgrepPath(filePath string) string {
	if strings.HasPrefix(filePath, "./") || strings.HasPrefix(filePath, ".\\") {
		filePath = filePath[2:]
	}
	return strings.ReplaceAll(filePath, "\\", "/")
}

// splitRipgrepLines mirrors `stdoutText.split(/\r?\n/)`.
//
// ★ A lone CR is NOT a separator here, and that is faithful: the TypeScript regex requires a
// newline after an optional CR, so a bare CR stays inside the line. Splitting on "\n" and then
// trimming the trailing CR would differ for a line containing an embedded CR, and would also
// turn a CR-only file into one line rather than zero lines.
func splitRipgrepLines(s string) []string {
	parts := make([]string, 0, 16)
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] != '\n' {
			continue
		}
		end := i
		if end > start && s[end-1] == '\r' {
			end--
		}
		parts = append(parts, s[start:end])
		start = i + 1
	}
	parts = append(parts, s[start:])
	return parts
}
