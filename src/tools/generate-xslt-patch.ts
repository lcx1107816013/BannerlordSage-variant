// XSLT patch generator: wraps an XPath-targeted insert/replace/delete into
// a full stylesheet with an identity transform, so the game importer applies
// the patch while leaving every other node untouched.

type XsltOperation = 'insert' | 'replace' | 'delete'

/** Shown when the caller supplies no fragment, so the stylesheet stays valid. */
const FRAGMENT_PLACEHOLDER = '<!-- TODO: add XML fragment here -->'

const XML_DECLARATION = `<?xml version="1.0" encoding="utf-8"?>
<xsl:stylesheet version="1.0"
  xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

  <xsl:output method="xml" indent="yes" encoding="utf-8" />
  <xsl:strip-space elements="*" />

`

/**
 * The identity transform. Kept as its own constant because it must appear
 * BEFORE the operation template and must survive verbatim: it is what makes
 * the patch additive rather than a whole-document replacement.
 */
const IDENTITY_TRANSFORM = `  <!-- Identity transform: keep everything by default -->
  <xsl:template match="@*|node()">
    <xsl:copy>
      <xsl:apply-templates select="@*|node()" />
    </xsl:copy>
  </xsl:template>

`

// The operation template already ends in a newline, and the stylesheet close
// starts with its own, so the two are separated by exactly one blank line.
const STYLESHEET_CLOSE = `
</xsl:stylesheet>
`

export async function generateXsltPatch(
  targetXPath: string,
  operation: XsltOperation,
  fragment?: string
) {
  const normalizedFragment = fragment?.trim() || FRAGMENT_PLACEHOLDER
  const operationTemplate = buildXsltOperation(targetXPath, operation, normalizedFragment)
  const template = `${XML_DECLARATION}${IDENTITY_TRANSFORM}${operationTemplate}${STYLESHEET_CLOSE}`

  return { content: [{ type: 'text' as const, text: template }] }
}

/** One operation template, dispatched by name. */
function buildXsltOperation(targetXPath: string, operation: XsltOperation, fragment: string): string {
  switch (operation) {
    case 'delete':
      // An empty template body drops the matched node entirely.
      return `  <!-- Delete the target node -->
  <xsl:template match="${targetXPath}" />
`

    case 'replace':
      return `  <!-- Replace the target node -->
  <xsl:template match="${targetXPath}">
    ${indentFragment(fragment, 2)}
  </xsl:template>
`

    // Everything else — including an unknown operation — inserts. The default
    // branch is deliberately the insert shape rather than an error.
    default:
      return `  <!-- Insert content inside the target node -->
  <xsl:template match="${targetXPath}">
    <xsl:copy>
      <xsl:apply-templates select="@*|node()" />
      ${indentFragment(fragment, 3)}
    </xsl:copy>
  </xsl:template>
`
  }
}

/** Indents every line of the fragment by `indentLevel` two-space levels. */
function indentFragment(fragment: string, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel)
  const lines = fragment.split(/\r?\n/)

  let indented = ''
  for (let index = 0; index < lines.length; index += 1) {
    // The separator goes BETWEEN lines, which is what join('\n') does; building
    // it explicitly keeps that from being an accident of the array method.
    if (index > 0) {
      indented += '\n'
    }
    indented += indent + lines[index]
  }

  return indented
}
