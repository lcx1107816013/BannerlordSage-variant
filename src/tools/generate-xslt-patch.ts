// XSLT patch generator: wraps an XPath-targeted insert/replace/delete into
// a full stylesheet with an identity transform, so the game importer applies
// the patch while leaving every other node untouched.
export async function generateXsltPatch(
  targetXPath: string,
  operation: 'insert' | 'replace' | 'delete',
  fragment?: string
) {
  const normalizedFragment = fragment?.trim() || '<!-- TODO: add XML fragment here -->'
  const template = `<?xml version="1.0" encoding="utf-8"?>
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

${buildXsltOperation(targetXPath, operation, normalizedFragment)}
</xsl:stylesheet>
`

  return { content: [{ type: 'text' as const, text: template }] }
}

function buildXsltOperation(
  targetXPath: string,
  operation: 'insert' | 'replace' | 'delete',
  fragment: string
): string {
  if (operation === 'delete') {
    // An empty template body drops the matched node entirely.
    return `  <!-- Delete the target node -->
  <xsl:template match="${targetXPath}" />
`
  }

  if (operation === 'replace') {
    return `  <!-- Replace the target node -->
  <xsl:template match="${targetXPath}">
    ${indentFragment(fragment, 2)}
  </xsl:template>
`
  }

  return `  <!-- Insert content inside the target node -->
  <xsl:template match="${targetXPath}">
    <xsl:copy>
      <xsl:apply-templates select="@*|node()" />
      ${indentFragment(fragment, 3)}
    </xsl:copy>
  </xsl:template>
`
}

function indentFragment(fragment: string, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel)
  return fragment
    .split(/\r?\n/)
    .map(line => `${indent}${line}`)
    .join('\n')
}
