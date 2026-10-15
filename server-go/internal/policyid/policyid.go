// Package policyid mirrors src/utils/bannerlord-policy-id.ts: it canonicalises the several ways
// a Bannerlord policy id is written in game data into the single form the index stores.
package policyid

import (
	"strings"

	"blore/internal/report"
)

// policyIDAliases mirrors POLICY_ID_ALIASES. The single entry here is a real data defect in the
// game files, not a convenience: the policy is spelled `..._grands_for_veteran` in some places
// and `..._grants_for_veterans` in the index, so lookups must map the former onto the latter.
var policyIDAliases = map[string]string{
	"policy_land_grands_for_veteran": "policy_land_grants_for_veterans",
}

// Normalize mirrors normalizeBannerlordPolicyId.
//
// ★ THE ORDER OF OPERATIONS IS LOAD-BEARING: trim, then strip a leading `Policy.`, then
// LOWERCASE, then alias. Doing the lowercase first would still strip the prefix — because the
// prefix test is case-INsensitive — but aliasing before lowercasing would fail to match the
// (already lowercase) alias keys, since game data writes the id with capitals.
//
// ★ The prefix test is case-insensitive (`/^Policy\./i`), so `POLICY.Foo`, `policy.foo` and
// `PoLiCy.Foo` all have the prefix removed while `Policy_Foo` (underscore, not a dot) does not.
// A port that used a case-sensitive prefix would leave the capitals in place and query a key
// that does not exist.
//
// ★ Empty results are treated as absent: both the initial empty input and an input that is
// nothing but the prefix (`"Policy."`) collapse to `""` and return ok=false. A bare `"."` does
// NOT: no prefix matches, so it lowercases to `"."` and is returned as a real (if useless) id.
//
// ── TWO MEASURED CASE-FOLDING DIVERGENCES (both from the JavaScript, both reproduced) ────────
//
// ★ THE TRIM IS JAVASCRIPT'S, NOT Go's. An earlier version used strings.TrimSpace, whose set
// differs from ECMAScript's in BOTH directions: TrimSpace keeps U+FEFF (a leading BOM would then
// survive into the id) and it REMOVES U+0085 (which JavaScript's trim does not, so an id ending in
// NEL would come back one character shorter than the original's). report.TrimJS holds the measured
// ECMAScript set and the report package's tests pin both directions, so this calls it rather than
// carrying a second copy of the set (F25).
//
// ★ THE LOWERCASE IS FULL UNICODE MAPPING, NOT simple per-rune mapping. An exhaustive comparison
// over every code point (0..0x10FFFF) found exactly ONE where strings.ToLower disagrees with
// String.prototype.toLowerCase: U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE), which JavaScript
// expands to `i` + U+0307 (COMBINING DOT ABOVE) while Go's simple mapping yields a bare `i`. The
// expansion matters here because the result is compared against the alias table, so `POLİCY_...`
// with a Turkish dotted I hits the alias in Go and misses it in JavaScript. U+0130 is special
// cased below.
//
// ★ NOT REPRODUCED, AND DELIBERATELY SO: JavaScript's Final_Sigma rule makes a capital sigma at the
// END of a word lowercase to `ς` (U+03C2) rather than `σ` (U+03C3), which is CONTEXT-dependent and
// therefore invisible to a per-code-point comparison. It is not implemented, because reproducing
// Unicode special casing in full is a large surface for an input class the index does not contain —
// measured: 0 of the 43 policy ids in the real index are non-ASCII, and 0 contain a capital. The
// difference is stated here rather than left for someone to discover.
func Normalize(value string) (string, bool) {
	if value == "" {
		return "", false
	}

	trimmed := report.TrimJS(value)

	if len(trimmed) >= len("policy.") {
		if strings.EqualFold(trimmed[:len("policy.")], "policy.") {
			trimmed = trimmed[len("policy."):]
		}
	}

	normalized := lowerFullUnicode(trimmed)
	if normalized == "" {
		return "", false
	}

	if aliased, ok := policyIDAliases[normalized]; ok {
		return aliased, true
	}
	return normalized, true
}

// lowerFullUnicode is strings.ToLower with the one difference an exhaustive comparison found.
//
// The comparison ran every code point through both JavaScript's String.prototype.toLowerCase and
// Go's strings.ToLower: U+0130 is the ONLY divergence. JavaScript applies the FULL mapping there
// (`i` followed by U+0307), Go applies the simple one (a bare `i`). Since that single mapping is
// the entire difference, special-casing it here reproduces the JavaScript result exactly rather
// than approximating it — and the special case is derived from a measurement, not from a guess
// about which characters "look Turkish".
func lowerFullUnicode(value string) string {
	if !strings.ContainsRune(value, '\u0130') {
		return strings.ToLower(value)
	}
	// Replace first, so the remaining mapping stays the standard one.
	return strings.ToLower(strings.ReplaceAll(value, "\u0130", "i\u0307"))
}
