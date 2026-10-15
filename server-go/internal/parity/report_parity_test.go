package parity_test

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"blore/internal/report"
)

// ─────────────────────────────────────────────────────────────────────────────
// Report-renderer parity (src/utils/ai-text.ts)
//
// Expected values come from tools/parity/report_fixtures.json, produced by
// EXECUTING the TypeScript. Hand-written expectations record the porter's belief;
// if the belief is wrong the test agrees with the mistake. That already happened
// once in this project (ledger F12), so the rule here is: never write the expected
// value by hand when the original can be executed.
//
// JSON cannot carry `undefined`, NaN or Infinity. The generator tags every scalar
// and substitutes sentinels for the unrepresentable ones, and decoding below
// mirrors that exactly — otherwise the Go side would test different inputs than the
// TypeScript was given while still printing "PASS".
// ─────────────────────────────────────────────────────────────────────────────

type reportScalar struct {
	Tag   string          `json:"tag"`
	Value json.RawMessage `json:"value"`
}

type reportScalarCase struct {
	Tag    string `json:"tag"`
	Value  any    `json:"value"`
	OK     bool   `json:"ok"`
	Result string `json:"result"`
	Error  string `json:"error"`
}

type reportRawField struct {
	Key   string        `json:"key"`
	Value *reportScalar `json:"value"`
}

type reportRawListField struct {
	Key    string         `json:"key"`
	Values []reportScalar `json:"values"`
}

type reportRawBlock struct {
	Header          string               `json:"header"`
	Fields          []reportRawField     `json:"fields"`
	ListFields      []reportRawListField `json:"listFields"`
	MultilineFields []reportRawField     `json:"multilineFields"`
}

type reportRawRender struct {
	Name string `json:"name"`
	// Inputs is the ACTUAL call arguments, tagged for JSON. The Go test replays
	// these rather than inventing its own — the first generator emitted results
	// without inputs, so the port was compared against empty values while the suite
	// still reported "compared N cases".
	Inputs struct {
		ReportType string           `json:"reportType"`
		QueryKey   string           `json:"queryKey"`
		QueryValue string           `json:"queryValue"`
		Blocks     []reportRawBlock `json:"blocks"`
		TopFields  []reportRawField `json:"topFields"`
	} `json:"inputs"`
	OK     bool   `json:"ok"`
	Result string `json:"result"`
	Error  string `json:"error"`
}

type reportFixtures struct {
	Scalars []reportScalarCase `json:"scalars"`
	Renders []reportRawRender  `json:"renders"`
}

func loadReportFixtures(t *testing.T) reportFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "report_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\nregenerate with: bun run server-go/tools/parity/gen_report_fixtures.mjs", path, err)
	}
	var f reportFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	// A fixture file that parsed but is empty would make every loop below pass
	// vacuously — the classic way a parity suite quietly stops testing anything.
	if len(f.Scalars) == 0 || len(f.Renders) == 0 {
		t.Fatalf("fixtures look empty (scalars=%d renders=%d); refusing to report success",
			len(f.Scalars), len(f.Renders))
	}
	return f
}

// decodeReportScalar turns a tagged fixture scalar into the value it represents.
// The `string` tag can carry a null, which the generator emits for the
// TypeScript's `undefined`; that must map to Absent, not to the string "".
func decodeReportScalar(t *testing.T, raw reportScalar) report.Scalar {
	t.Helper()
	switch raw.Tag {
	case "undefined":
		return report.Absent()
	case "null":
		return report.Null()
	case "boolean":
		var b bool
		if err := json.Unmarshal(raw.Value, &b); err != nil {
			t.Fatalf("bad boolean fixture: %v", err)
		}
		return report.Bool(b)
	case "number":
		// NaN and the infinities cannot cross JSON, so the generator writes them as
		// sentinel STRINGS. Missing this branch was a real bug in the harness: NaN was
		// JSON-encoded as null, decoded as 0, and the port then "failed" with
		// `nan: 0` versus `nan: NaN` — a harness defect that looked like a port defect.
		switch string(raw.Value) {
		case `"NaN"`:
			return report.Number(math.NaN())
		case `"Infinity"`:
			return report.Number(math.Inf(1))
		case `"-Infinity"`:
			return report.Number(math.Inf(-1))
		}
		var f float64
		if err := json.Unmarshal(raw.Value, &f); err != nil {
			t.Fatalf("bad number fixture %s: %v", string(raw.Value), err)
		}
		return report.Number(f)
	case "string":
		if string(raw.Value) == "null" {
			return report.Absent()
		}
		var s string
		if err := json.Unmarshal(raw.Value, &s); err != nil {
			t.Fatalf("bad string fixture: %v", err)
		}
		return report.Text(s)
	default:
		t.Fatalf("unknown scalar tag %q", raw.Tag)
		return report.Absent()
	}
}

func decodeReportField(t *testing.T, raw reportRawField) report.Field {
	t.Helper()
	return report.Field{Key: raw.Key, Value: decodeReportScalar(t, *raw.Value)}
}

func decodeReportFields(t *testing.T, raws []reportRawField) []report.Field {
	out := make([]report.Field, 0, len(raws))
	for i := range raws {
		out = append(out, decodeReportField(t, raws[i]))
	}
	return out
}

func decodeReportBlocks(t *testing.T, raws []reportRawBlock) []report.Block {
	out := make([]report.Block, 0, len(raws))
	for _, rb := range raws {
		block := report.Block{
			Header:          rb.Header,
			Fields:          decodeReportFields(t, rb.Fields),
			MultilineFields: decodeReportFields(t, rb.MultilineFields),
		}
		for _, lf := range rb.ListFields {
			values := make([]report.Scalar, 0, len(lf.Values))
			for _, v := range lf.Values {
				values = append(values, decodeReportScalar(t, v))
			}
			block.ListFields = append(block.ListFields,
				report.ListField{Key: lf.Key, Values: values})
		}
		out = append(out, block)
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────────────

func TestReportScalarsMatchTypeScript(t *testing.T) {
	f := loadReportFixtures(t)
	compared := 0
	for _, c := range f.Scalars {
		if !c.OK {
			// The TypeScript threw for this input; there is no expected value. Kept
			// in the file as a record of behaviour rather than silently dropped.
			t.Logf("skipping (TypeScript threw): tag=%s error=%s", c.Tag, c.Error)
			continue
		}
		valueJSON, err := json.Marshal(c.Value)
		if err != nil {
			t.Fatalf("cannot re-encode fixture value: %v", err)
		}
		got := decodeReportScalar(t, reportScalar{Tag: c.Tag, Value: valueJSON}).Format()
		if got != c.Result {
			t.Errorf("formatAiScalar tag=%s value=%s\n  go = %q\n  ts = %q",
				c.Tag, string(valueJSON), got, c.Result)
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no scalar cases were compared")
	}
	t.Logf("compared %d scalar cases against the TypeScript output", compared)
}

func TestReportRenderMatchesTypeScript(t *testing.T) {
	f := loadReportFixtures(t)
	compared := 0
	for _, c := range f.Renders {
		if !c.OK {
			t.Logf("skipping (TypeScript threw): %s error=%s", c.Name, c.Error)
			continue
		}
		got := report.Render(c.Inputs.ReportType, c.Inputs.QueryKey, c.Inputs.QueryValue,
			decodeReportBlocks(t, c.Inputs.Blocks), decodeReportFields(t, c.Inputs.TopFields))
		if got != c.Result {
			t.Errorf("render %q differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				c.Name, got, c.Result, reportFirstDiff(got, c.Result))
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no render cases were compared")
	}
	t.Logf("compared %d render cases against the TypeScript output", compared)
}

// Number formatting gets its own test because it is where a "reasonable"
// implementation silently diverges. Measured: JS uses exponential only for
// |x| >= 1e21 or |x| < 1e-6 and never zero-pads the exponent, so Go's 'g' verb is
// wrong at both boundaries (1e-05, 1e-07) and 'f' is wrong past them. The `why`
// column names the verb that would have been wrong, so a future reader does not
// "simplify" this back into a bug.
func TestReportNumberFormattingMatchesJavaScript(t *testing.T) {
	cases := []struct {
		value float64
		want  string
		why   string
	}{
		{0, "0", "plain"},
		{math.Copysign(0, -1), "0", "JS String(-0) is \"0\"; a naive formatter gives \"-0\""},
		{100, "100", "plain"},
		{0.1, "0.1", "plain"},
		{1.0 / 3.0, "0.3333333333333333", "shortest round-trip, same as JS"},

		// Lower boundary: decimal down to 1e-6 inclusive.
		{1e-5, "0.00001", "Go 'g' would give \"1e-05\""},
		{1e-6, "0.000001", "Go 'g' would give \"1e-06\""},
		// ...then exponential below it, WITHOUT zero padding.
		{1e-7, "1e-7", "Go 'g' gives \"1e-07\"; Go 'f' gives \"0.0000001\""},
		{1.5e-7, "1.5e-7", "Go 'g' would give \"1.5e-07\""},

		// Upper boundary: decimal up to 1e20, exponential from 1e21.
		{1e20, "100000000000000000000", "Go 'g' would give \"1e+20\""},
		{1e21, "1e+21", "exponential, with the '+'"},
		{12345678901234567890, "12345678901234567000", "precision loss matches JS"},

		{math.NaN(), "NaN", "JS String(NaN)"},
		{math.Inf(1), "Infinity", "JS String(Infinity)"},
		{math.Inf(-1), "-Infinity", "JS String(-Infinity)"},
		{5e-324, "5e-324", "smallest subnormal"},
		{1.7976931348623157e308, "1.7976931348623157e+308", "largest float64"},
	}

	for _, c := range cases {
		got := report.Number(c.value).Format()
		if got != c.want {
			t.Errorf("format(%v) = %q, want %q  (%s)", c.value, got, c.want, c.why)
		}
	}
	t.Logf("pinned %d number-formatting cases, including both exponent boundaries", len(cases))
}

// reportFirstDiff names the first differing line, which is far more useful than
// two full dumps when only whitespace differs.
func reportFirstDiff(a, b string) string {
	al := strings.Split(a, "\n")
	bl := strings.Split(b, "\n")
	for i := 0; i < len(al) && i < len(bl); i++ {
		if al[i] != bl[i] {
			return "first difference at line " + strconv.Itoa(i+1) +
				": go=" + strconv.Quote(al[i]) + " ts=" + strconv.Quote(bl[i])
		}
	}
	if len(al) != len(bl) {
		return "line counts differ: go=" + strconv.Itoa(len(al)) + " ts=" + strconv.Itoa(len(bl))
	}
	return "no line difference (trailing bytes only)"
}
