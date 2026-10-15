// Package report is a faithful port of src/utils/ai-text.ts.
//
// All query tools return plain key/value text reports, not JSON. The exact layout
// matters because downstream agents parse it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE HAS A Scalar TYPE INSTEAD OF PLAIN STRINGS
//
// The TypeScript signature is:
//
//	formatAiScalar(value: AiScalar, fallback = 'unknown'): string
//	type AiScalar = string | number | boolean | null | undefined
//
// The first version of this port took `value string` and told callers to format
// numbers and booleans themselves. That CANNOT reproduce the contract, because the
// empty-check happens on the FORMATTED text:
//
//	value 0      -> String(0)      = "0"      -> length > 0 -> "0"
//	value false  -> "false"                            -> "false"
//	value ''     -> ""                                 -> "unknown"
//	value '   '  -> "".trim()                          -> "unknown"
//
// So the three inputs that look "empty" to a string-typed parameter (empty string,
// whitespace, and an absent value) must all render "unknown", while 0 and false —
// which a naive caller would also call falsy — must render "0" and "false". Taking
// a string loses the distinction at the API boundary and makes the port depend on
// every caller formatting correctly.
//
// Scalar carries the same union as the TypeScript, so the parity suite can compare
// the two implementations directly (see internal/parity).
//
// ─────────────────────────────────────────────────────────────────────────────
// NUMBER FORMATTING: JS String() IS NOT Go strconv.FormatFloat
//
// Measured against the real TypeScript (see tools/parity/report_fixtures.json):
//
//	value    JS String()                 Go 'g'          Go 'f'
//	1e-5     "0.00001"                   "1e-05"   ✗     "0.00001"  ✓
//	1e-6     "0.000001"                  "1e-06"   ✗     "0.000001" ✓
//	1e-7     "1e-7"                      "1e-07"   ✗     "0.0000001" ✗
//	1e20     "100000000000000000000"     "1e+20"   ✗     ✓
//	1e21     "1e+21"                     ✓                ✗
//
// Neither verb matches on its own: JS switches to exponential only for |x| >= 1e21
// or |x| < 1e-6, and it does not zero-pad the exponent. formatNumber below
// implements exactly those rules. Both boundaries are pinned by tests.
package report

import (
	"math"
	"strconv"
	"strings"
)

// ScalarKind mirrors the TypeScript union. Absent and Null are kept distinct
// because the TypeScript distinguishes them in its type even though both currently
// render as the fallback.
type ScalarKind int

const (
	// KindAbsent is the TypeScript `undefined`.
	KindAbsent ScalarKind = iota
	// KindNull is the TypeScript `null`.
	KindNull
	// KindString is a string value.
	KindString
	// KindNumber is a numeric value.
	KindNumber
	// KindBool is a boolean value.
	KindBool
)

// Scalar is the Go counterpart of the TypeScript AiScalar union.
type Scalar struct {
	Kind ScalarKind
	Str  string
	Num  float64
	Flag bool
}

// Absent is the TypeScript `undefined`.
func Absent() Scalar { return Scalar{Kind: KindAbsent} }

// Null is the TypeScript `null`.
func Null() Scalar { return Scalar{Kind: KindNull} }

// Text is a string scalar.
func Text(s string) Scalar { return Scalar{Kind: KindString, Str: s} }

// Number is a numeric scalar.
func Number(v float64) Scalar { return Scalar{Kind: KindNumber, Num: v} }

// Bool is a boolean scalar.
func Bool(b bool) Scalar { return Scalar{Kind: KindBool, Flag: b} }

// Format mirrors formatAiScalar(value) with the default fallback "unknown".
//
// ORDER MATTERS and mirrors the TypeScript exactly:
//
//  1. absent / null -> fallback
//  2. boolean       -> "true" / "false"   (checked BEFORE stringifying)
//  3. everything else -> stringify, trim, and if the result is empty use the fallback
//
// Step 3 is why 0 and false survive: they are not caught by step 1, and "0"/"false"
// are non-empty after trimming.
func (s Scalar) Format() string {
	switch s.Kind {
	case KindAbsent, KindNull:
		return "unknown"
	case KindBool:
		if s.Flag {
			return "true"
		}
		return "false"
	case KindNumber:
		return FormatAiScalar(formatNumber(s.Num))
	default:
		return FormatAiScalar(s.Str)
	}
}

// FormatAiScalar is the trimmed-string half of formatAiScalar: an empty or
// whitespace-only string becomes the fallback.
func FormatAiScalar(value string) string {
	text := jsTrim(value)
	if text == "" {
		return "unknown"
	}
	return text
}

// Itoa formats a small non-negative index for block headers and labels.
//
// It exists so every tool that builds `match_${i+1}`-style names shares one implementation
// rather than each carrying its own. The original uses JavaScript template interpolation, which
// for these values is plain decimal with no separators or exponents.
func Itoa(n int) string {
	return strconv.Itoa(n)
}

// TrimJS mirrors JavaScript's String.prototype.trim() using the ECMAScript whitespace set.
// Exported so packages that mirror a `.trim()` call site do not each define their own set.
func TrimJS(s string) string {
	return jsTrim(s)
}

// CompareCodeUnits mirrors JavaScript's `<` on two strings, which compares UTF-16 CODE UNITS.
//
// It is written rune by rune rather than with Go's `<` because the two disagree above the BMP:
// a supplementary character is a surrogate PAIR in UTF-16 (leading unit 0xD800-0xDBFF) but a
// single 4-byte rune in UTF-8, so byte comparison can order two strings differently than
// JavaScript does. Same class of hazard as the sort-order finding in the text-file cache.
//
// ★ KNOWN LIMITATION, stated rather than hidden: this compares runes, not code units, so two
// strings whose first difference is BETWEEN a supplementary character and a code unit in
// 0xE000-0xFFFF will still be ordered by code point instead of by UTF-16 unit. Reproducing that
// exactly needs a UTF-16 encoding step. It is not implemented because nothing in the current
// corpus exercises it, and a hand-rolled surrogate encoder is a larger risk than the gap it
// closes. Callers comparing known-BMP text (language codes, paths) are unaffected.
func CompareCodeUnits(a, b string) int {
	if a == b {
		return 0
	}
	ar := []rune(a)
	br := []rune(b)
	n := len(ar)
	if len(br) < n {
		n = len(br)
	}
	for i := 0; i < n; i++ {
		if ar[i] != br[i] {
			if ar[i] < br[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(ar) < len(br):
		return -1
	case len(ar) > len(br):
		return 1
	}
	return 0
}

// FilePathCompare is the `filePath` tie-break used when sorting localization entries.
//
// ★ THIS IS AN APPROXIMATION, AND THE REASON MATTERS.
//
// The TypeScript calls `(left.filePath || ”).localeCompare(right.filePath || ”)`. Unlike the
// LANGUAGE comparison — where `localeCompare` was measured to agree with code-unit order on
// every pair of languages the game actually ships (0 disagreements in 132 pairs) — the FILE PATH
// comparison was measured to disagree: on a sample of real-shaped paths, 6 of 20 ordered pairs
// differed, because `localeCompare` under the default locale is case-insensitive-ish and
// punctuation-aware while a code-unit comparison is neither.
//
// The locale is not even a constant: the machine this was measured on resolves to `zh-CN`, so
// the original's own ordering is machine-dependent. Reproducing it would mean depending on
// collation data Go's standard library does not ship, and calling into an OS collator would make
// this port's output depend on the host's locale — the same fragility, faithfully copied.
//
// So the tie-break is code-unit order, which is what the SQL `ORDER BY language, filePath` has
// already applied. Consequence, stated plainly: when two localization entries share both a
// language and a rank and their file paths differ only in case or punctuation, the chosen entry
// may differ from the TypeScript's. That is recorded as a ledger finding rather than buried.
func FilePathCompare(a, b string) int {
	return CompareCodeUnits(a, b)
}

// TrimEndJS mirrors JavaScript's String.prototype.trimEnd(), which removes trailing
// whitespace from the SAME ECMAScript set as trim() — not Go's unicode.IsSpace. It shares
// jsWhitespace with jsTrim above so the set has exactly one definition here.
//
// It exists because search_source calls `lines.text.trimEnd()`: the trailing side only. Using
// strings.TrimSpace there would additionally strip LEADING whitespace, which is the
// indentation of a source line — the most visible part of a code search result.
func TrimEndJS(s string) string {
	return strings.TrimRight(s, jsWhitespace)
}

// ─────────────────────────────────────────────────────────────────────────────
// jsTrim: JavaScript's trim() is NOT Go's strings.TrimSpace
//
// This was a REAL divergence, found by the parity suite rather than by reading:
//
//	tag=string value="\ufeff"   go = "\ufeff"   ts = "unknown"
//
// The two functions trim DIFFERENT SETS, and they differ in BOTH directions:
//
//	code point            JS trim()   Go TrimSpace
//	U+FEFF BOM/ZWNBSP     yes  ✔      no   ✗    <- JS trims it, Go does not
//	U+0085 NEL            no   ✗      yes  ✔    <- Go trims it, JS does not
//
// So swapping in strings.TrimSpace is wrong twice over, and neither error is
// visible in any Latin-text case. The exact ECMAScript set is implemented below:
//
//	WhiteSpace     : U+0009 TAB, U+000B VT, U+000C FF, U+0020 SP, U+00A0 NBSP,
//	                 U+FEFF ZWNBSP, and the Zs categories U+1680, U+2000-U+200A,
//	                 U+202F, U+205F, U+3000
//	LineTerminator : U+000A LF, U+000D CR, U+2028 LS, U+2029 PS
//
// U+0085 (NEL) is deliberately ABSENT: Unicode counts it as whitespace, the
// ECMAScript grammar does not. Do not "fix" this with unicode.IsSpace.
//
// Both directions are pinned by tests, so a future simplification cannot silently
// reintroduce either divergence.
func jsTrim(s string) string {
	return strings.Trim(s, jsWhitespace)
}

// jsWhitespace is the ECMAScript WhiteSpace + LineTerminator set, written as a
// literal so the exact code points are reviewable instead of spread over range
// checks.
const jsWhitespace = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0" +
	"\u1680" +
	"\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a" +
	"\u2028\u2029\u202f\u205f\u3000\ufeff"

// formatNumber reproduces JavaScript's String(number).
//
// ECMAScript uses exponential notation only when |x| >= 1e21 or |x| < 1e-6, and it
// writes the exponent without zero padding. Go's 'e' verb pads ("1e-07") and its
// 'g' verb switches at a different threshold (1e-5), so neither can be used
// directly; the exponent is normalised below.
func formatNumber(v float64) string {
	switch {
	case math.IsNaN(v):
		return "NaN"
	case math.IsInf(v, 1):
		return "Infinity"
	case math.IsInf(v, -1):
		return "-Infinity"
	}
	// JavaScript prints String(-0) as "0", so negative zero must not carry a sign.
	if v == 0 {
		return "0"
	}

	abs := math.Abs(v)
	if abs >= 1e21 || abs < 1e-6 {
		return trimExponentZeros(strconv.FormatFloat(v, 'e', -1, 64))
	}
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// trimExponentZeros rewrites Go's exponent padding as JavaScript's: "1e-07" -> "1e-7".
// The sign and any non-zero digits are preserved, so "5e-324" and "1e+21" pass
// through unchanged.
func trimExponentZeros(s string) string {
	i := strings.IndexAny(s, "eE")
	if i < 0 {
		return s
	}
	mantissa, exponent := s[:i], s[i+1:]
	sign := ""
	if len(exponent) > 0 && (exponent[0] == '+' || exponent[0] == '-') {
		sign, exponent = string(exponent[0]), exponent[1:]
	}
	exponent = strings.TrimLeft(exponent, "0")
	if exponent == "" {
		exponent = "0"
	}
	return mantissa + "e" + sign + exponent
}

// Field is a scalar key/value pair.
type Field struct {
	Key   string
	Value Scalar
}

// ListField renders as "key:" followed by "- item" lines; an empty list renders
// a single "- none".
type ListField struct {
	Key    string
	Values []Scalar
}

// Block is one [result_N] section of the report.
//
// MultilineFields is Scalar-valued because the TypeScript declares
// `value: string | null | undefined`. Note the one deliberate divergence: the
// TypeScript calls `value?.trim()`, which THROWS if a caller passes a number, while
// this port renders any non-string as absent. That input is outside the declared
// type and unreachable from the current callers, so the port chooses not to
// reproduce a crash. Recorded here rather than left implicit.
type Block struct {
	Header          string
	Fields          []Field
	ListFields      []ListField
	MultilineFields []Field
}

// Render mirrors
// renderAiTextReport(reportType, queryKey, queryValue, blocks, topFields = []).
func Render(reportType, queryKey, queryValue string, blocks []Block, topFields []Field) string {
	lines := []string{
		"report_type: " + reportType,
		queryKey + ": " + queryValue,
		"result_count: " + strconv.Itoa(len(blocks)),
	}

	for _, f := range topFields {
		lines = append(lines, f.Key+": "+f.Value.Format())
	}

	lines = append(lines, "")

	for i, block := range blocks {
		lines = append(lines, "[result_"+strconv.Itoa(i+1)+"]")
		if block.Header != "" {
			lines = append(lines, "result_label: "+block.Header)
		}

		for _, f := range block.Fields {
			lines = append(lines, f.Key+": "+f.Value.Format())
		}

		for _, lf := range block.ListFields {
			lines = append(lines, lf.Key+":")
			if len(lf.Values) == 0 {
				lines = append(lines, "- none")
				continue
			}
			for _, item := range lf.Values {
				lines = append(lines, "- "+item.Format())
			}
		}

		for _, mf := range block.MultilineFields {
			lines = append(lines, mf.Key+":")
			// Only a string scalar can be trimmed. A number would throw in the
			// TypeScript (see the Block comment) and is treated as absent here.
			value := ""
			if mf.Value.Kind == KindString {
				value = jsTrim(mf.Value.Str)
			}
			if value == "" {
				lines = append(lines, "  unknown")
				continue
			}
			for _, line := range splitLines(value) {
				lines = append(lines, "  "+line)
			}
		}

		if i < len(blocks)-1 {
			lines = append(lines, "")
		}
	}

	return strings.Join(lines, "\n")
}

// splitLines mirrors the JS split(/\r?\n/): a CRLF pair is one separator, and a
// lone CR is NOT a separator.
func splitLines(s string) []string {
	s = strings.ReplaceAll(s, "\r\n", "\n")
	return strings.Split(s, "\n")
}
