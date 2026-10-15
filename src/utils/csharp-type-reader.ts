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

  const selectedRows = rows.slice(0, MAX_TYPE_MATCHES)
  const blocks: AiTextBlock[] = []

  for (const row of selectedRows) {
    const fullPath = join(sourcePath, row.filePath)
    if (!(await file(fullPath).exists())) continue

    const lineCount = row.endLine - row.startLine + 1
    const slice = await readTextFileSlice(fullPath, row.startLine, lineCount)

    let finalCode = slice.text
    let header = `// ${row.typeKind} ${row.fullName} @ ${row.filePath}:${row.startLine + 1}-${row.endLine + 1}`

    if (lineCount > MAX_LINES_THRESHOLD) {
      finalCode = summarizeTypeSurface(slice.text)
      header += ' [implementation collapsed]'
    }

    blocks.push({
      header: `type_match_${blocks.length + 1}`,
      fields: [
        { key: 'type_kind', value: row.typeKind },
        { key: 'full_type_name', value: row.fullName },
        { key: 'file_path', value: row.filePath },
        { key: 'start_line_1based', value: row.startLine + 1 },
        { key: 'end_line_1based', value: row.endLine + 1 },
        { key: 'line_count', value: lineCount },
        { key: 'implementation_collapsed', value: lineCount > MAX_LINES_THRESHOLD ? 'true' : 'false' },
        { key: 'summary_header', value: header },
      ],
      multilineFields: [{ key: 'code', value: finalCode }],
    })
  }

  const text = renderAiTextReport(reportType, queryLabel, typeName, blocks, [
    ...topFields,
    { key: 'total_matches_found', value: rows.length },
    { key: 'matches_returned', value: blocks.length },
    { key: 'match_limit', value: MAX_TYPE_MATCHES },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Collapses a large type body down to its member surface: namespace and
 * type scaffolding plus member signatures (brace depth ≤ 1) survive;
 * everything deeper is replaced by a placeholder inside the opening brace.
 * String and comment contents are stripped before counting braces so
 * literal braces cannot skew the depth tracking.
 */
function summarizeTypeSurface(code: string): string {
  const lines = code.split('\n')
  const output: string[] = []
  let depth = 0

  for (const line of lines) {
    const sanitized = line.replace(/\/\/.*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
    let depthChange = 0
    for (const char of sanitized) {
      if (char === '{') depthChange += 1
      else if (char === '}') depthChange -= 1
    }

    if (depth <= 1) {
      output.push(line)
      if (depth === 1 && depthChange > 0 && !line.includes('}')) {
        output.push('    // ... implementation hidden ...')
      }
    } else if (depth + depthChange <= 1) {
      const indent = line.match(/^\s*/)?.[0] || ''
      output.push(`${indent}}`)
    }

    depth += depthChange
  }

  return output.join('\n')
}
