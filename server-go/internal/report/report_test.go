package report

import (
	"math"
	"strings"
	"testing"
)

// These are examples of the shapes this renderer is used with. The authoritative
// check lives in internal/parity, which compares every value against output
// EXECUTED from src/utils/ai-text.ts.
//
// Do not add an expectation here because it "looks right". The previous version of
// this file asserted a layout from memory, and the parity suite later found the
// renderer's API could not even represent booleans and numbers — the test agreed
// with the port, so both were wrong together. If a value here is in doubt,
// regenerate tools/parity/report_fixtures.json and see what the TypeScript
// actually returns.
func TestRenderExampleLayout(t *testing.T) {
	blocks := []Block{
		{
			Header: "match_1",
			Fields: []Field{
				{Key: "module_name", Value: Text("Native")},
				{Key: "file_path", Value: Text("Modules/Native/a.xml")},
			},
			MultilineFields: []Field{{Key: "snippet", Value: Text("line1\r\nline2")}},
		},
		{
			Header:          "match_2",
			Fields:          []Field{{Key: "file_path", Value: Text("")}},
			ListFields:      []ListField{{Key: "tags", Values: []Scalar{}}},
			MultilineFields: []Field{{Key: "text", Value: Text("   ")}},
		},
	}
	got := Render("xml_search", "query_text", "gauntlet ui", blocks, []Field{
		{Key: "fts_query", Value: Text(`"gauntlet"* AND "ui"*`)},
	})

	want := `report_type: xml_search
query_text: gauntlet ui
result_count: 2
fts_query: "gauntlet"* AND "ui"*

[result_1]
result_label: match_1
module_name: Native
file_path: Modules/Native/a.xml
snippet:
  line1
  line2

[result_2]
result_label: match_2
file_path: unknown
tags:
- none
text:
  unknown`

	if got != want {
		t.Fatalf("render mismatch:\n--- got ---\n%s\n--- want ---\n%s", got, want)
	}
}

// The values that a string-typed API cannot express. This is the reason Scalar
// exists, so it is asserted directly rather than left to the parity suite alone.
func TestScalarFalsyValuesSurvive(t *testing.T) {
	cases := []struct {
		in   Scalar
		want string
	}{
		{Absent(), "unknown"},
		{Null(), "unknown"},
		{Text(""), "unknown"},
		{Text("   "), "unknown"},
		{Text("\t\n "), "unknown"},

		// These three are the trap: all three would be "empty" if the check were
		// done on the raw value or on Go truthiness, but the TypeScript stringifies
		// first, so they must render literally.
		{Number(0), "0"},
		{Bool(false), "false"},
		{Text("0"), "0"},

		{Bool(true), "true"},
		{Text(" x "), "x"},
		{Text("unknown"), "unknown"},
	}
	for _, c := range cases {
		if got := c.in.Format(); got != c.want {
			t.Errorf("Format(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// The exponent boundaries, restated here so the rule is visible from inside the
// package too. internal/parity carries the full matrix.
func TestFormatNumberBoundaries(t *testing.T) {
	cases := []struct {
		in   float64
		want string
	}{
		{1e-5, "0.00001"}, // not exponential
		{1e-6, "0.000001"},
		{1e-7, "1e-7"}, // exponential, and NOT zero-padded
		{1e20, "100000000000000000000"},
		{1e21, "1e+21"},
		{math.Copysign(0, -1), "0"}, // -0 prints without a sign
		{math.NaN(), "NaN"},
		{math.Inf(1), "Infinity"},
	}
	for _, c := range cases {
		if got := Number(c.in).Format(); got != c.want {
			t.Errorf("format(%v) = %q, want %q", c.in, got, c.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// The trim divergence, in BOTH directions.
//
// JS trim() and Go strings.TrimSpace trim different sets. The parity suite found
// the first direction (U+FEFF) as a real failure; the second (U+0085) is asserted
// here because it is the direction that a "simplify this to TrimSpace" edit would
// silently INTRODUCE, and no Latin-text case would ever catch it.
// ─────────────────────────────────────────────────────────────────────────────

func TestJsTrimMatchesECMAScriptNotGo(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string // "" means it trims to empty -> Format renders "unknown"
	}{
		{"ascii space", "  x  ", "x"},
		{"tab/newline", "\t\nx\r", "x"},
		{"NBSP U+00A0", "\u00a0x\u00a0", "x"},

		// ★ Direction 1: JS trims it, Go TrimSpace does NOT. This is the real bug the
		// parity fixtures caught: a string of only U+FEFF must render "unknown".
		{"BOM U+FEFF alone", "\ufeff", ""},
		{"BOM U+FEFF around text", "\ufeffx\ufeff", "x"},

		// Other Zs separators JS trims.
		{"OGHAM U+1680", "\u1680x", "x"},
		{"EN QUAD U+2000", "\u2000x", "x"},
		{"HAIR SPACE U+200A", "\u200ax", "x"},
		{"NARROW NBSP U+202F", "\u202fx", "x"},
		{"MEDIUM MATH U+205F", "\u205fx", "x"},
		{"IDEOGRAPHIC U+3000", "\u3000x", "x"},
		{"LINE SEP U+2028", "\u2028x", "x"},
		{"PARA SEP U+2029", "\u2029x", "x"},

		// ★ Direction 2: Go TrimSpace trims it, JS does NOT. If someone replaces
		// jsTrim with strings.TrimSpace this case starts failing, which is the point.
		{"NEL U+0085 is NOT JS whitespace", "\u0085", "\u0085"},
	}
	for _, c := range cases {
		got := Text(c.input).Format()
		want := c.want
		if want == "" {
			want = "unknown"
		}
		if got != want {
			t.Errorf("jsTrim %s: Format(%q) = %q, want %q", c.name, c.input, got, want)
		}
	}

	// The multiline path uses the same trim, so a BOM-only snippet must render
	// "  unknown" rather than "  \ufeff".
	rendered := Render("t", "k", "v", []Block{{
		MultilineFields: []Field{{Key: "s", Value: Text("\ufeff")}},
	}}, nil)
	if !strings.Contains(rendered, "s:\n  unknown") {
		t.Errorf("multiline with BOM-only value should render unknown, got:\n%s", rendered)
	}
}
