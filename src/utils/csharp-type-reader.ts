/**
 * Renders an indexed C# type (or the disambiguation report for several
 * same-named types) as MCP text content. Matches are capped, oversized
 * bodies are collapsed to their member surface, and missing source files
 * are skipped silently.
 */
import { Database } from 'bun:sqlite'
import { file } from 'bun'
import { join } from 'node:path'
import { type AiTextBlock, type AiTextField, renderAiTextReport } from './ai-text'
import { readTextFileSlice } from './text-file-cache'

const MAX_LINES_THRESHOLD = 400
const MAX_TYPE_MATCHES = 5
/** Depth at which the collapse proof line is inserted inside an opening brace. */
const SURFACE_DEPTH = 1
/** String and comment contents are erased before braces are counted, so a
 * literal `{` inside them cannot skew the depth. */
const NON_CODE_TEXT = /\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g
const HIDDEN_IMPLEMENTATION_LINE = '    // ... implementation hidden ...'
const LEADING_WHITESPACE = /^\s*/

type CSharpTypeMatchRow = {
  filePath: string
  startLine: number
  endLine: number
  fullName: string
  typeKind: string
}

type ReadIndexedCSharpTypeOptions = {
  db: Database
  sourcePath: string
  typeName: string
  queryLabel?: string
  reportType?: string
  notFoundText?: string
  topFields?: AiTextField[]
}

export async function readIndexedCsharpType(options: ReadIndexedCSharpTypeOptions) {
  const {
    db,
    sourcePath,
    typeName,
    queryLabel = 'query_type_name',
    reportType = 'csharp_type_read',
    notFoundText = `Type '${typeName}' was not found in the index.`,
    topFields = [],
  } = options

  // Shortest full name sorts first, so the plain (un-namespaced) candidate
  // is presented before any namespaced twin of the same type name.
  const rows = db
    .query<CSharpTypeMatchRow, { $name: string }>(
      `
      SELECT filePath, startLine, endLine, fullName, typeKind
      FROM csharp_types
      WHERE typeName = $name
      ORDER BY LENGTH(fullName), filePath
    `
    )
    .all({ $name: typeName })

  if (rows.length === 0) {
    return {
      content: [{ type: 'text' as const, text: notFoundText }],
    }
  }

  const blocks: AiTextBlock[] = []

  for (const row of rows.slice(0, MAX_TYPE_MATCHES)) {
    const fullPath = join(sourcePath, row.filePath)
    // A row whose file is gone contributes no block at all — the count
    // reported below is therefore "blocks actually rendered", not "rows found".
    if (!(await file(fullPath).exists())) continue

    blocks.push(await buildTypeBlock(row, fullPath, blocks.length))
  }

  const text = renderAiTextReport(reportType, queryLabel, typeName, blocks, [
    ...topFields,
    { key: 'total_matches_found', value: rows.length },
    { key: 'matches_returned', value: blocks.length },
    { key: 'match_limit', value: MAX_TYPE_MATCHES },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

/** One rendered `type_match_N` block for an existing source file. */
async function buildTypeBlock(
  row: CSharpTypeMatchRow,
  fullPath: string,
  blocksSoFar: number
): Promise<AiTextBlock> {
  const lineCount = row.endLine - row.startLine + 1
  const slice = await readTextFileSlice(fullPath, row.startLine, lineCount)
  const isCollapsed = lineCount > MAX_LINES_THRESHOLD

  const code = isCollapsed ? summarizeTypeSurface(slice.text) : slice.text
  const header = buildTypeHeader(row, isCollapsed)

  return {
    header: `type_match_${blocksSoFar + 1}`,
    fields: [
      { key: 'type_kind', value: row.typeKind },
      { key: 'full_type_name', value: row.fullName },
      { key: 'file_path', value: row.filePath },
      { key: 'start_line_1based', value: row.startLine + 1 },
      { key: 'end_line_1based', value: row.endLine + 1 },
      { key: 'line_count', value: lineCount },
      { key: 'implementation_collapsed', value: isCollapsed ? 'true' : 'false' },
      { key: 'summary_header', value: header },
    ],
    multilineFields: [{ key: 'code', value: code }],
  }
}

/** `// class X @ file.cs:1-20`, marked when the body was collapsed. */
function buildTypeHeader(row: CSharpTypeMatchRow, isCollapsed: boolean): string {
  const location = `${row.typeKind} ${row.fullName} @ ${row.filePath}:${row.startLine + 1}-${row.endLine + 1}`
  return isCollapsed ? `// ${location} [implementation collapsed]` : `// ${location}`
}

/** Net brace depth change contributed by one source line. */
function braceDelta(line: string): number {
  const codeOnly = line.replace(NON_CODE_TEXT, '')
  let delta = 0

  for (const char of codeOnly) {
    if (char === '{') delta += 1
    else if (char === '}') delta -= 1
  }

  return delta
}

/**
 * Collapses a large type body down to its member surface: namespace and
 * type scaffolding plus member signatures (brace depth ≤ 1) survive;
 * everything deeper is replaced by a placeholder inside the opening brace.
 * String and comment contents are stripped before counting braces so
 * literal braces cannot skew the depth tracking.
 */
function summarizeTypeSurface(code: string): string {
  const output: string[] = []
  let depth = 0

  for (const line of code.split('\n')) {
    const delta = braceDelta(line)
    const opensANewBody = depth === SURFACE_DEPTH && delta > 0 && !line.includes('}')
    const closesBackToSurface = depth + delta <= SURFACE_DEPTH

    if (depth <= SURFACE_DEPTH) {
      output.push(line)
      if (opensANewBody) {
        output.push(HIDDEN_IMPLEMENTATION_LINE)
      }
    } else if (closesBackToSurface) {
      // Only the closing brace is kept for deep lines; the member list above
      // already said what the body was.
      const indent = line.match(LEADING_WHITESPACE)?.[0] || ''
      output.push(`${indent}}`)
    }

    depth += delta
  }

  return output.join('\n')
}
