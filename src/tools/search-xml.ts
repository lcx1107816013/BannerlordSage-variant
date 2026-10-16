// Full-text search over the indexed game XML corpus. The query becomes a
// conjunctive FTS5 phrase query, ranked with bm25 weights that favor file
// paths over body text, capped at ten results.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'

export async function searchXml(query: string) {
  const db = getDb()
  const ftsQuery = buildFtsQuery(query)
  const matchRows = db
    .query<any, any>(
      `
      SELECT
        filePath,
        moduleName,
        snippet(xml_documents_fts, 2, '[', ']', ' ... ', 18) AS snippet
      FROM xml_documents_fts
      WHERE xml_documents_fts MATCH $query
      ORDER BY bm25(xml_documents_fts, 8.0, 4.0, 1.0)
      LIMIT 10
    `
    )
    .all({ $query: ftsQuery })

  const footnotes = [{ key: 'fts_query', value: ftsQuery }]

  if (matchRows.length === 0) {
    return reply(renderAiTextReport('xml_search', 'query_text', query, [], footnotes))
  }

  const blocks: AiTextBlock[] = matchRows.map((matchRow, position) => ({
    header: `match_${position + 1}`,
    fields: [
      { key: 'module_name', value: matchRow.moduleName },
      { key: 'file_path', value: matchRow.filePath },
    ],
    multilineFields: [{ key: 'snippet', value: matchRow.snippet || '(no snippet)' }],
  }))

  return reply(renderAiTextReport('xml_search', 'query_text', query, blocks, footnotes))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

// Quotes every whitespace-separated token as an FTS prefix phrase joined
// with AND, so "harmony patch" only matches documents holding both terms.
function buildFtsQuery(query: string): string {
  const cleaned = query.trim().replace(/"/g, ' ')
  if (!cleaned) return '""'

  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .map(token => `"${token}"*`)
    .join(' AND ')
}
