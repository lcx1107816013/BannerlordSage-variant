// Package fts ports buildFtsQuery() from src/tools/search-docs.ts (and the
// identical copy in src/tools/search-api-docs.ts).
//
// User input is turned into a conjunction of quoted prefix terms:
//
//	"gauntlet ui" -> "gauntlet"* AND "ui"*
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ORDER OF THESE TWO LINES IS THE WHOLE CONTRACT. DO NOT "TIDY" IT.
//
//	cleaned := strings.ReplaceAll(strings.TrimSpace(query), `"`, " ")
//	if cleaned == "" { return `""` }
//
// The TypeScript is:
//
//	const cleaned = query.trim().replace(/"/g, ' ')
//	if (!cleaned) return '""'
//
// i.e. it tests emptiness BEFORE stripping quotes. That ordering looks wrong and
// invites a "fix" (test after stripping, so quote-only input also returns '""').
// Applying that fix BREAKS PARITY, and the observable difference is:
//
//	input     faithful (TS + this file)     the tempting "fix"
//	''        '""'  (match-nothing)         '""'
//	'   '     '""'  (match-nothing)         '""'
//	'"'       ''    <-- EMPTY               '""'
//	'""'      ''    <-- EMPTY               '""'
//	'" "'     ''    <-- EMPTY               '""'
//
// Why the faithful path yields ”: `'"'` trims to `'"'`, the quote is replaced by
// a space giving `' '`, and `' '` is TRUTHY in JavaScript — so the guard does not
// fire. Execution falls through to the split, filter(Boolean) drops the empties,
// and joining an empty list yields ”. Go reaches the same result for free:
// strings.Fields(" ") is empty and strings.Join of nothing is "".
//
// This was measured, not reasoned about. The expected values in
// tools/parity/fixtures.json are produced by EXECUTING the real TypeScript.
//
// KNOWN HAZARD, deliberately preserved: an empty MATCH expression is not the same
// as "match nothing". The guard is plainly meant to make empty input match
// nothing (hence the '""' phrase), and quote-only input slipping past it to ”
// looks like an upstream oversight — but changing it here would make the port
// disagree with the shipped TypeScript, which is worse while the port's whole
// claim is losslessness. Parity first; divergence only as a recorded decision.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW THIS FILE WAS ALMOST SHIPPED WRONG
//
// The first version of this file had the ordering right: it returned ” for
// quote-only input, matching the TypeScript. A hand-written unit test in this
// package asserted `"` -> '""' — the author's MISREADING of the TS. The test then
// "failed", and the code was changed to match the test. The port was correct and
// the test was wrong, so the bug was introduced by trusting the test.
//
// The differential suite (internal/parity) caught it immediately, because it
// compares against output executed from the TypeScript rather than against a
// human's reading of it. That is the entire reason that suite exists.
package fts

import (
	"strings"
)

func BuildQuery(query string) string {
	cleaned := strings.ReplaceAll(strings.TrimSpace(query), `"`, " ")
	if cleaned == "" {
		return `""`
	}

	tokens := strings.Fields(cleaned)
	parts := make([]string, 0, len(tokens))
	for _, token := range tokens {
		if token == "" {
			continue
		}
		parts = append(parts, `"`+token+`"*`)
	}
	return strings.Join(parts, " AND ")
}
