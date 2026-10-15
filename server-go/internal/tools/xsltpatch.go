package tools

import (
	"strings"

	"blore/internal/report"
)

// GenerateXsltPatch mirrors generateXsltPatch from src/tools/generate-xslt-patch.ts: it wraps an
// XPath-targeted insert/replace/delete into a complete XSLT stylesheet carrying an identity
// transform, so the game importer applies the change and leaves every other node alone.
//
// ★ THE RETURN IS THE STYLESHEET TEXT, NOT A REPORT. The TypeScript returns
// `{ content: [{ type: 'text', text: template }] }` with no renderAiTextReport call, so there is
// no report_type line and no query field. Adding one here would change the tool's output.
//
// ★ THE DEFAULT FRAGMENT IS A COMMENT, NOT EMPTY TEXT. `fragment?.trim() || '...'` is a
// truthiness test on the TRIMMED value, so a fragment of "   " is treated as absent and the
// placeholder comment is emitted instead. Note which string survives: the trimmed one, so a
// fragment surrounded by newlines loses them.
func GenerateXsltPatch(targetXPath, operation, fragment string) (string, error) {
	normalizedFragment := report.TrimJS(fragment)
	if normalizedFragment == "" {
		normalizedFragment = "<!-- TODO: add XML fragment here -->"
	}

	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <xsl:output method="xml" indent="yes" encoding="utf-8" />
  <xsl:strip-space elements="*" />

  <!-- Identity transform: keep everything by default -->
  <xsl:template match="@*|node()">
    <xsl:copy>
      <xsl:apply-templates select="@*|node()" />
    </xsl:copy>
  </xsl:template>

`)
	// The TypeScript interpolates buildXsltOperation's result, which ALREADY ENDS WITH A NEWLINE,
	// and then the template's own newline before </xsl:stylesheet>. Both are reproduced: the
	// operation text below ends with "\n" and the closing line is appended after another.
	b.WriteString(buildXsltOperation(targetXPath, operation, normalizedFragment))
	b.WriteString("\n</xsl:stylesheet>\n")

	return b.String(), nil
}

// buildXsltOperation mirrors buildXsltOperation.
//
// ★ THE OPERATION IS COMPARED AS AN EXACT STRING. The TypeScript's parameter type is the union
// 'insert' | 'replace' | 'delete', and anything else falls through to the INSERT branch — there
// is no validation and no error. That is mirrored: an unknown operation produces an insert, it
// does not fail.
//
// ★ `delete` EMITS A SELF-CLOSING TEMPLATE WITH AN EMPTY BODY. An empty template body is what
// removes the matched node; giving it a body would silently turn a delete into a no-op.
func buildXsltOperation(targetXPath, operation, fragment string) string {
	if operation == "delete" {
		return "  <!-- Delete the target node -->\n" +
			"  <xsl:template match=\"" + targetXPath + "\" />\n"
	}

	if operation == "replace" {
		return "  <!-- Replace the target node -->\n" +
			"  <xsl:template match=\"" + targetXPath + "\">\n" +
			"    " + indentFragment(fragment, 2) + "\n" +
			"  </xsl:template>\n"
	}

	return "  <!-- Insert content inside the target node -->\n" +
		"  <xsl:template match=\"" + targetXPath + "\">\n" +
		"    <xsl:copy>\n" +
		"      <xsl:apply-templates select=\"@*|node()\" />\n" +
		"      " + indentFragment(fragment, 3) + "\n" +
		"    </xsl:copy>\n" +
		"  </xsl:template>\n"
}

// indentFragment mirrors indentFragment: every line gets `'  '.repeat(indentLevel)` prepended and
// the lines are rejoined with "\n".
//
// ★ THE SPLIT IS /\\r?\\n/, WHICH IS NOT "SPLIT ON NEWLINES". A CRLF pair is ONE separator, and a
// LONE CR is NOT a separator at all — so a fragment using old-Mac line endings comes back as a
// single line with the CRs still inside it, and receives exactly one indent. The join is always
// a bare "\n", so CRLF input comes out LF-only. Both halves are the original's behaviour.
func indentFragment(fragment string, indentLevel int) string {
	indent := strings.Repeat("  ", indentLevel)
	lines := splitOnCRLFOrLF(fragment)
	for i, line := range lines {
		lines[i] = indent + line
	}
	return strings.Join(lines, "\n")
}

// splitOnCRLFOrLF mirrors JavaScript's String.prototype.split(/\r?\n/).
//
// It is written as a replacement plus a plain split rather than with regexp so the rule is
// visible: "?\n" consumes a CR only when a LF follows it.
func splitOnCRLFOrLF(s string) []string {
	return strings.Split(strings.ReplaceAll(s, "\r\n", "\n"), "\n")
}
