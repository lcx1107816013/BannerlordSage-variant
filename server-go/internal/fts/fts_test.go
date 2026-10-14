package fts

import "testing"

// These are examples of the shapes this function is used with, plus the two
// surprising-but-real cases. The authoritative check lives in internal/parity,
// which compares every value against output EXECUTED from the TypeScript.
//
// Do not add an expectation here because it "looks right". Both of the odd cases
// below were nearly encoded backwards once already: a hand-written test asserted
// `"` -> '""', the code was changed to satisfy it, and the port silently stopped
// matching upstream. If you believe a value here is wrong, regenerate
// tools/parity/fixtures.json and see what the TypeScript actually returns.
func TestBuildQuery(t *testing.T) {
	cases := []struct{ in, want string }{
		{"gauntlet ui", `"gauntlet"* AND "ui"*`},
		{"  CalculateSpeed  ", `"CalculateSpeed"*`},
		{`say "hello" now`, `"say"* AND "hello"* AND "now"*`},
		{"", `""`},
		{"   ", `""`},

		// Truthy-empty cases: the TS guard runs BEFORE quotes are stripped, so a
		// quote-only query falls through to an empty join and yields "" — NOT the
		// match-nothing phrase `""`. Verified against executed TypeScript.
		{`"`, ``},
		{`""`, ``},
		{`" "`, ``},
	}
	for _, c := range cases {
		if got := BuildQuery(c.in); got != c.want {
			t.Errorf("BuildQuery(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}
