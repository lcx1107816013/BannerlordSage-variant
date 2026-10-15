package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blore/internal/tools"
)

// ─────────────────────────────────────────────────────────────────────────────
// generate_xslt_patch parity (src/tools/generate-xslt-patch.ts)
//
// The tool returns a plain XSLT stylesheet — no renderAiTextReport wrapper — so the fixture is
// the raw text and the comparison is byte-for-byte.
//
// The corpus pins the details a careful reader would "correct":
//   - `fragment?.trim() || placeholder` tests the TRIMMED value, so "   " yields the placeholder
//     and a fragment wrapped in newlines loses the wrapping
//   - the operation is matched as an EXACT string; an unknown one takes the INSERT branch
//   - indentFragment splits on /\r?\n/: CRLF is one separator, a LONE CR is none, and the join
//     is always "\n"
// ─────────────────────────────────────────────────────────────────────────────

type xpCase struct {
	XPath    string `json:"xpath"`
	Op       string `json:"op"`
	Fragment string `json:"fragment"`
	OK       bool   `json:"ok"`
	Text     string `json:"text"`
	Error    string `json:"error"`
}

type xpFixtures struct {
	Cases []xpCase `json:"cases"`
}

func loadXSLTPatchFixtures(t *testing.T) xpFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "xsltpatch_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_xsltpatch_fixtures.mjs", path, err)
	}
	var f xpFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.Cases {
		if !c.OK {
			t.Fatalf("fixture case (op=%q) recorded a THROW (%s); this port has no error branch", c.Op, c.Error)
		}
	}
	return f
}

func TestGenerateXSLTPatchMatchesTypeScript(t *testing.T) {
	f := loadXSLTPatchFixtures(t)

	for _, c := range f.Cases {
		got, err := tools.GenerateXsltPatch(c.XPath, c.Op, c.Fragment)
		if err != nil {
			t.Errorf("GenerateXsltPatch(%q, %q, %q) errored: %v", c.XPath, c.Op, c.Fragment, err)
			continue
		}
		if got != c.Text {
			t.Errorf("GenerateXsltPatch(%q, %q, %q) differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				c.XPath, c.Op, c.Fragment, got, c.Text, textFirstDiff(got, c.Text))
		}
	}
	t.Logf("compared %d generate_xslt_patch stylesheets against the TypeScript", len(f.Cases))
}

// TestGenerateXSLTPatchBranchDistinctness asserts the three branches are actually DIFFERENT from
// each other for the same inputs. A port that collapsed them would still match a fixture set that
// happened to contain only one branch; this makes the collapse fail.
func TestGenerateXSLTPatchBranchDistinctness(t *testing.T) {
	const xpath = "//target"
	const fragment = "<x />"

	insert, err := tools.GenerateXsltPatch(xpath, "insert", fragment)
	if err != nil {
		t.Fatalf("insert: %v", err)
	}
	replace, err := tools.GenerateXsltPatch(xpath, "replace", fragment)
	if err != nil {
		t.Fatalf("replace: %v", err)
	}
	deleted, err := tools.GenerateXsltPatch(xpath, "delete", fragment)
	if err != nil {
		t.Fatalf("delete: %v", err)
	}

	if insert == replace || insert == deleted || replace == deleted {
		t.Fatal("two branches produced identical output; the operation is not being honoured")
	}

	if !strings.Contains(deleted, `<xsl:template match="//target" />`) {
		t.Errorf("delete branch is not a self-closing empty template:\n%s", deleted)
	}
	if strings.Contains(deleted, fragment) {
		t.Error("delete branch interpolated the fragment; it must ignore it")
	}

	// NOTE: the insert branch's xsl:copy is deliberately NOT asserted by searching for
	// `<xsl:copy>` — the identity-transform block contains that markup in EVERY branch, so a
	// "replace must not contain xsl:copy" check fails on the wrapper rather than on the branch.
	// (It did exactly that when first written.) The branches are separated by comparing each
	// one's text against its own fixture below, where the expected value is the TS output.

	// An unknown operation takes the INSERT branch rather than erroring — the TS has no validation.
	unknown, err := tools.GenerateXsltPatch(xpath, "upsert", fragment)
	if err != nil {
		t.Fatalf("unknown operation returned an error; the TS falls through to insert: %v", err)
	}
	if unknown != insert {
		t.Error("an unknown operation did not take the insert branch")
	}

	// The identity transform and the stylesheet wrapper must be present in all three.
	for name, out := range map[string]string{"insert": insert, "replace": replace, "delete": deleted} {
		if !strings.Contains(out, `<xsl:template match="@*|node()">`) {
			t.Errorf("%s: the identity transform is missing", name)
		}
		if !strings.HasPrefix(out, `<?xml version="1.0" encoding="utf-8"?>`) {
			t.Errorf("%s: the XML declaration is missing from the start", name)
		}
		if !strings.HasSuffix(out, "</xsl:stylesheet>\n") {
			t.Errorf("%s: the stylesheet does not end with the closing tag and a newline", name)
		}
	}
}

// TestGenerateXSLTPatchIndentSplitting pins the split rule THROUGH THE FIXTURE, so the expectation
// is the TypeScript's own output rather than a guess about how the indentation composes.
//
// ★ AN EARLIER VERSION OF THIS TEST WAS WRONG, and the reason is worth keeping (F12): it asserted
// that a CRLF fragment becomes two lines indented by six spaces, and that the replace branch
// contains no `xsl:copy`. Both failed while the real comparison passed — the template writes its
// own indentation in front of only the FIRST interpolated line, and the identity-transform prose
// contains that markup. The assertions below are derived from the fixture instead.
//
// The property being separated: CRLF is ONE separator, so a CRLF fragment must render EXACTLY like
// the LF one; a LONE CR is not a separator, so it must NOT.
func TestGenerateXSLTPatchIndentSplitting(t *testing.T) {
	f := loadXSLTPatchFixtures(t)

	for _, fragment := range []string{"one\r\ntwo", "one\rtwo", "one\ntwo\nthree", "trailing\n"} {
		got, err := tools.GenerateXsltPatch("//a", "insert", fragment)
		if err != nil {
			t.Fatalf("fragment %q: %v", fragment, err)
		}
		want := fixtureFor(t, f, "//a", "insert", fragment)
		if got != want {
			t.Errorf("fragment %q differs\n--- go ---\n%q\n--- ts ---\n%q\n--- %s ---",
				fragment, got, want, textFirstDiff(got, want))
		}
	}

	crlf, err := tools.GenerateXsltPatch("//a", "insert", "one\r\ntwo")
	if err != nil {
		t.Fatal(err)
	}
	lf, err := tools.GenerateXsltPatch("//a", "insert", "one\ntwo")
	if err != nil {
		t.Fatal(err)
	}
	if crlf != lf {
		t.Errorf("CRLF and LF fragments produced different output; CRLF must be ONE separator\n--- crlf ---\n%q\n--- lf ---\n%q", crlf, lf)
	}

	loneCR, err := tools.GenerateXsltPatch("//a", "insert", "one\rtwo")
	if err != nil {
		t.Fatal(err)
	}
	if loneCR == lf {
		t.Error("a LONE CR was treated as a line separator; in the TS it is not one")
	}
	if !strings.Contains(loneCR, "one\rtwo") {
		t.Errorf("the lone CR did not survive inside the line:\n%q", loneCR)
	}
}

// fixtureFor returns the recorded TypeScript output for an exact (xpath, op, fragment) triple.
//
// It FAILS when the corpus has no such case, rather than returning "" — an assertion against a
// missing fixture would otherwise pass or fail for the wrong reason, which is the failure mode
// this whole suite exists to avoid.
func fixtureFor(t *testing.T, f xpFixtures, xpath, op, fragment string) string {
	t.Helper()
	for _, c := range f.Cases {
		if c.XPath == xpath && c.Op == op && c.Fragment == fragment {
			return c.Text
		}
	}
	t.Fatalf("the corpus has no case for (%q, %q, %q); this assertion would be testing nothing",
		xpath, op, fragment)
	return ""
}
