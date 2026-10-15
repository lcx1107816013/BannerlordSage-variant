package tools

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"blore/internal/report"
	"blore/internal/textfilecache"
)

// Constants mirror src/utils/csharp-type-reader.ts.
const (
	// maxLinesThreshold mirrors MAX_LINES_THRESHOLD: above this the body is collapsed.
	maxLinesThreshold = 400
	// maxTypeMatches mirrors MAX_TYPE_MATCHES, and it is applied in THREE places that must
	// agree: the row slice, the `match_limit` field, and the meaning of `matches_returned`.
	maxTypeMatches = 5
)

// CsharpTypeOptions carries the parameters the TypeScript destructures with defaults.
//
// ★ THE ZERO VALUE IS NOT A DEFAULT — ReadCsharpType FILLS EVERY FIELD IN.
//
// The TypeScript reads `options.queryLabel ?? ...`, so a caller that passes an explicit
// empty string gets the empty string. Here an empty field is indistinguishable from an
// omitted one, so the defaults are applied by value rather than by presence.
//
// That matters for exactly one field. Unlike NotFoundText (whose default interpolates the
// raw typeName), the two labels and TopFields have no such dependency, so no zero value
// this struct can hold loses information. The second call site,
// src/utils/local-mod-csharp-index.ts readLocalModType, supplies reportType
// "local_mod_type_read", its own notFoundText and four topFields — that is the whole
// reason this struct and the sourcePath parameter exist instead of hard-coded values.
type CsharpTypeOptions struct {
	QueryLabel   string
	ReportType   string
	NotFoundText string
	TopFields    []report.Field
}

// ReadCsharpType mirrors readIndexedCsharpType in src/utils/csharp-type-reader.ts, plus
// src/tools/read-csharp-type.ts, which calls it with the game's sourcePath.
//
// It returns the rendered report text for the successful and no-match cases. The (string,
// error) shape is Go's; the not-found answer is a NORMAL string, not an error — see below.
//
// ── ★ THREE BEHAVIOURS THAT LOOK LIKE BUGS AND ARE REPRODUCED ANYWAY ─────────────────────
//
//  1. A ROW WHOSE FILE IS MISSING IS SKIPPED SILENTLY and does not consume a header number.
//     Headers are `type_match_${blocks.length + 1}` evaluated at push time, so a skip does
//     not burn an index — the surviving matches are always numbered 1..n with no gaps.
//     Consequence: `total_matches_found` (rows.length, BEFORE the slice) can exceed
//     `matches_returned` for a reason that is neither the limit nor the file count.
//
//  2. `matches_returned` is `blocks.length`, i.e. it counts rows that SURVIVED both the
//     slice and the existence check — so it can legitimately be lower than both
//     `total_matches_found` and `match_limit`.
//
//  3. The file-existence check happens BEFORE the slice is read, so a missing file is not
//     an error and does not abort the whole answer. Do not "improve" it into an error.
func ReadCsharpType(db *sql.DB, sourcePath, typeName string, opts CsharpTypeOptions) (string, error) {
	// Defaults are applied here rather than in a wrapper so a caller cannot reach this
	// function with a half-filled struct: there is one entry point, as in the TypeScript.
	if opts.QueryLabel == "" {
		opts.QueryLabel = "query_type_name"
	}
	if opts.ReportType == "" {
		opts.ReportType = "csharp_type_read"
	}
	if opts.NotFoundText == "" {
		// ★ The raw typeName argument, NOT a trimmed or canonicalised form.
		opts.NotFoundText = fmt.Sprintf("Type '%s' was not found in the index.", typeName)
	}

	// ORDER BY LENGTH(fullName), filePath — the ordering is observable, so it is left to
	// the engine exactly as the TypeScript leaves it. LENGTH() here is SQLite's, and it is
	// the same function in both implementations because it is the same engine.
	rows, err := db.Query(`
		SELECT filePath, startLine, endLine, fullName, typeKind
		FROM csharp_types
		WHERE typeName = ?
		ORDER BY LENGTH(fullName), filePath`, typeName)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type typeMatchRow struct {
		filePath  string
		startLine int
		endLine   int
		fullName  string
		typeKind  string
	}
	all := make([]typeMatchRow, 0, 8)
	for rows.Next() {
		var r typeMatchRow
		if err := rows.Scan(&r.filePath, &r.startLine, &r.endLine, &r.fullName, &r.typeKind); err != nil {
			return "", err
		}
		all = append(all, r)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	// ★ The not-found answer is a plain string, NOT an error and NOT a report. The
	// TypeScript returns `{content: [{type: 'text', text: notFoundText}]}` — a tool result,
	// not a thrown error — so an MCP caller sees an ordinary successful call whose text
	// happens to be a sentence rather than a report.
	if len(all) == 0 {
		return opts.NotFoundText, nil
	}

	selected := all
	if len(selected) > maxTypeMatches {
		selected = selected[:maxTypeMatches]
	}

	blocks := make([]report.Block, 0, len(selected))
	for _, row := range selected {
		fullPath := filepath.Join(sourcePath, row.filePath)

		// Mirrors `if (!(await file(fullPath).exists())) continue`.
		//
		// ★ MEASURED against bun 1.4.3 on Windows: Bun.file(p).exists() returns FALSE for
		// a DIRECTORY. So this is not a plain "does the path exist" test — a row whose
		// filePath points at a directory is skipped here, and a port that used a bare
		// os.Stat would render the directory as a `code` field containing its children's
		// error text or, with reads, fail differently. That is why fileExists below asks
		// for a regular file.
		//
		// Measured edges, all reproduced by fileExists: a trailing separator on a FILE
		// still reports true (`nonempty.cs/`), a trailing separator on a DIRECTORY reports
		// false, and a missing path reports false. The trailing-separator case cannot be
		// reproduced exactly in Go on Windows — os.Stat rejects `file.cs/` with
		// "The directory name is invalid" — but it is unreachable from this call site,
		// because index-csharp.ts stores filePath via normalizeFilePath(), always a relative
		// path with no trailing separator.
		if !fileExists(fullPath) {
			continue
		}

		lineCount := row.endLine - row.startLine + 1
		slice, err := textfilecache.ReadSlice(fullPath, row.startLine, lineCount)
		if err != nil {
			return "", err
		}

		finalCode := slice.Text
		header := fmt.Sprintf("// %s %s @ %s:%d-%d",
			row.typeKind, row.fullName, row.filePath, row.startLine+1, row.endLine+1)

		if lineCount > maxLinesThreshold {
			finalCode = summarizeTypeSurface(slice.Text)
			// ★ The marker is APPENDED AFTER summarisation and only under the same
			// condition that chose the summary. It is part of the header, not a field.
			header += " [implementation collapsed]"
		}

		blocks = append(blocks, report.Block{
			// ★ Evaluated at push time, so a skipped row does not consume a number.
			Header: "type_match_" + report.Itoa(len(blocks)+1),
			Fields: []report.Field{
				{Key: "type_kind", Value: report.Text(row.typeKind)},
				{Key: "full_type_name", Value: report.Text(row.fullName)},
				{Key: "file_path", Value: report.Text(row.filePath)},
				{Key: "start_line_1based", Value: report.Number(float64(row.startLine + 1))},
				{Key: "end_line_1based", Value: report.Number(float64(row.endLine + 1))},
				{Key: "line_count", Value: report.Number(float64(lineCount))},
				// ★ A STRING "true"/"false", not a boolean. `report.Bool` would render the
				// same text today, so the difference is invisible until someone changes the
				// renderer or compares the two implementations field by field.
				{Key: "implementation_collapsed", Value: report.Text(boolText(lineCount > maxLinesThreshold))},
				{Key: "summary_header", Value: report.Text(header)},
			},
			MultilineFields: []report.Field{{Key: "code", Value: report.Text(finalCode)}},
		})
	}

	// The top fields keep the SAME order as the TypeScript, and the caller's fields come
	// first because the source spreads `...topFields` before its own three.
	topFields := make([]report.Field, 0, len(opts.TopFields)+3)
	topFields = append(topFields, opts.TopFields...)
	topFields = append(topFields,
		// ★ rows.length, i.e. the count BEFORE the slice and BEFORE the existence check.
		report.Field{Key: "total_matches_found", Value: report.Number(float64(len(all)))},
		report.Field{Key: "matches_returned", Value: report.Number(float64(len(blocks)))},
		report.Field{Key: "match_limit", Value: report.Number(float64(maxTypeMatches))},
	)

	return report.Render(opts.ReportType, opts.QueryLabel, typeName, blocks, topFields), nil
}

// fileExists mirrors `(await Bun.file(path).exists())`.
//
// ★ IT ANSWERS "IS THIS A REGULAR FILE", NOT "DOES THIS PATH EXIST" — measured, not assumed:
//
//	path                            Bun exists   os.Stat succeeds   this
//	regular file                    true         yes                 true
//	a DIRECTORY                     false        yes  <- the trap     false
//	missing                         false        no                  false
//	trailing separator on a file    true         no (Windows)        false  <- see below
//	trailing separator on a dir     false        yes                 false
//	dangling symlink                false        no                  false
//
// An earlier revision of this port used a bare os.Stat, which reported every directory and
// the drive root as existing. The rows that reach here come from normalizeFilePath() and so
// are ordinary relative paths to .cs files, but the fields are re-read from the index, and
// the whole point of the guard is to tolerate a stale index — the case where a path in the
// DB no longer names a file, including the case where a directory now sits at that path.
//
// The trailing-separator row is the one edge that does NOT agree, and it is stated rather
// than hidden: On Windows os.Stat rejects `x.cs/` outright, while Bun opens it fine. No
// caller can produce that path at this call site (see the comment in ReadCsharpType), so
// the gap is unreachable; it is noted for whoever reuses this helper.
func fileExists(fullPath string) bool {
	info, err := os.Stat(fullPath)
	if err != nil {
		return false
	}
	return info.Mode().IsRegular()
}

// erasure matches the TypeScript literal
//
//	/\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g
//
// ★ THIS IS NOT A COPY OF THE LITERAL AND THE DIFFERENCE WAS MEASURED. Writing the `.`
// characters straight across compiles fine and is WRONG in three places, because Go's
// regexp `.` (any rune except LF) is not ECMAScript's `.` (any code unit except LF, CR,
// U+2028, U+2029):
//
//	raw line                              JS sanitized      naive Go       corrected
//	`x(); // c\r}`                        `x(); \r}`        `x(); `        `x(); \r}`
//	`x(); // c\u2028}`                    `x(); \u2028}`    `x(); `        `x(); \u2028}`
//	`s = "a\<CR>b";` (backslash + CR)     unchanged         `s = ;`        unchanged
//
// The last line is the `\\.` alternative: ECMAScript refuses to let `.` consume a line
// terminator, so a backslash followed by CR does not form an escape and the literal is not
// erased at all. That changes the BRACE COUNT, which is the whole input to the summary, so
// it is not a cosmetic difference. Only `\\.` is affected — the character class `[^"\\]`
// DOES match CR, U+2028 and U+2029 (a negated class is the complement of its operands in
// both languages), which is why `s = "a<CR>//b"; }` is erased by the string alternative
// upstream. Writing `[^"\\\n\r\u2028\u2029]` there is the tempting "consistent" fix and it
// is wrong:
//
//	line                       JS sanitized        explicit body class   [^"\\] body class
//	`s = "a<CR>//b"; }`        `s = ; }`           `s = "a<CR>` + junk   `s = ; }`
//
// So the two classes are deliberately asymmetric:
//
//	\\[^\n\r\u2028\u2029]   the escape  (JS `.` after a backslash)
//	[^"\\] / [^'\\]         the body    (JS negated class: line terminators INCLUDED)
//
// ★ ON ASTRAL CHARACTERS THE TWO ENGINES ITERATE DIFFERENTLY — AND IT IS NOT OBSERVABLE HERE.
// ECMAScript advances one UTF-16 code unit at a time, so a surrogate pair is two iterations
// and `\\.` can consume just the high half; Go advances one rune, so `\\.` consumes the pair.
// That looked like a real hazard (the escape alternative is ANCHORED, unlike the comment
// alternative, so the two engines could in principle disagree about where a literal ends).
// It does not: whichever half is consumed by which alternative, the total consumed is the
// same and the closing quote is reached identically. Measured rather than argued — the
// differential corpus used while porting includes U+1F3AF and U+1F600 both bare and
// immediately after a backslash, and 166,375 fragment triples produced no case where the
// two disagree.
// A LONE surrogate cannot appear in this input at all: it is not valid UTF-8, so neither a
// file read nor the index can carry one into a Go string.
//
// ★ THE ALTERNATION IS LEFT-TO-RIGHT, WHICH IS WHAT MAKES `"http://x"` SURVIVE. The regex
// engine takes the leftmost match, so for `var u = "http://x";` the string alternative (at
// the opening quote) starts EIGHT characters before the `//` alternative would, and the
// whole literal is erased as a string. A "strip comments first, then strings" rewrite —
// which reads more naturally — deletes the rest of the line instead, and since the brace
// count is what decides the output, that is a silent behavioural change.
var erasure = regexp.MustCompile(
	`//[^\n\r\x{2028}\x{2029}]*` +
		`|"(?:[^"\\]|\\[^\n\r\x{2028}\x{2029}])*"` +
		`|'(?:[^'\\]|\\[^\n\r\x{2028}\x{2029}])*'`)

// leadingWhitespace matches the leading run of characters in the ECMAScript WhiteSpace +
// LineTerminator set, mirroring JS `line.match(/^\s*/)`.
//
// ★ Go's `\s` CANNOT BE USED HERE: it is ASCII-only, and the ECMAScript set contains
// U+00A0, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. Measured
// against bun 1.4.3: `"\u00a0}\u00a0".match(/^\s*/)` returns the U+00A0, and Go's `^\s*`
// returns "" — and this indent is emitted verbatim as the collapsed line's indentation.
// The set enumerated here is the same 25 code points the JS engine accepts (verified by
// scanning the whole code space, not by reading the spec), and it is the same set
// report.jsWhitespace uses; it is spelled out again because that one is unexported.
var leadingWhitespace = regexp.MustCompile(
	`^[\t\n\v\f\r \x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*`)

// hiddenMarker is the literal 4-space string the TypeScript pushes; the indentation is
// FIXED and is not derived from the surrounding line.
const hiddenMarker = "    // ... implementation hidden ..."

// summarizeTypeSurface mirrors summarizeTypeSurface(code) exactly.
//
// Per line, in this order:
//
//  1. erase `//` comments and string/char literals with the regex above;
//  2. count braces in what is LEFT;
//  3. if depth <= 1, emit the ORIGINAL line (not the sanitized one) — and additionally the
//     hidden marker when depth === 1 && depthChange > 0 && !line.includes('}');
//  4. otherwise, if depth+depthChange <= 1, emit the line's leading indent followed by "}";
//  5. depth += depthChange.
//
// ★ DEPTH CAN GO NEGATIVE AND IS NOT CLAMPED. A closing brace at depth 0 makes depth -1, so
// the NEXT line is judged against -1: a line with depthChange +2 can push it to +1 without
// ever emitting anything, and lines are silently dropped. Reproduced, not fixed.
//
// ★ `line.includes('}')` IS A PLAIN SUBSTRING TEST ON THE RAW LINE, not a regex and not the
// sanitized text — so a `}` inside a comment or a string literal suppresses the hidden
// marker. `strings.Contains(line, "}")` is an exact equivalent here; there is no trim or
// locale hazard in a substring test, but note it is a CODE-UNIT test in both languages, so
// it is not affected by the surrogate difference documented above.
//
// ★ THE SPLIT IS BYTE-WISE ON "\n" AND THAT IS FAITHFUL. `code` is a textfilecache slice,
// which was already split on /\r?\n/ and rejoined with "\n" upstream, so no CR can reach
// here from the file; the TypeScript splits the same already-normalised text the same way.
// Do NOT route this through report's CRLF-aware splitLines — that would be a different
// function with a different result on a lone CR, and the two are only coincidentally equal
// on the input that actually arrives.
func summarizeTypeSurface(code string) string {
	lines := strings.Split(code, "\n")
	output := make([]string, 0, len(lines))
	depth := 0

	for _, line := range lines {
		sanitized := erasure.ReplaceAllString(line, "")

		depthChange := 0
		for i := 0; i < len(sanitized); i++ {
			switch sanitized[i] {
			case '{':
				depthChange++
			case '}':
				depthChange--
			}
		}

		if depth <= 1 {
			output = append(output, line)
			if depth == 1 && depthChange > 0 && !strings.Contains(line, "}") {
				output = append(output, hiddenMarker)
			}
		} else if depth+depthChange <= 1 {
			indent := leadingWhitespace.FindString(line)
			output = append(output, indent+"}")
		}

		depth += depthChange
	}

	return strings.Join(output, "\n")
}
