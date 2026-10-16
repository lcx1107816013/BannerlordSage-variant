import { databaseHasTable, getDb } from '../utils/db'
import { getGamePaths } from '../utils/env'
import { renderAiTextReport, type AiTextBlock } from '../utils/ai-text'

type DocsSourceFilter = 'own' | 'all' | 'official' | 'community'

/** The `source` column value each filter selects; 'all' applies no filter. */
const SOURCE_FILTER_COLUMNS = new Map<DocsSourceFilter, string | null>([
  ['own', 'own_knowledge'],
  ['official', 'official_moddocs'],
  ['community', 'community_modding_docs'],
  ['all', null],
])

/** Rows per page when the caller passes something unusable. */
const DOCS_DEFAULT_LIMIT = 8
const DOCS_MIN_LIMIT = 1
const DOCS_MAX_LIMIT = 25

export async function searchDocs(query: string, source: DocsSourceFilter = 'own', limit = 8) {
  const db = getDb()
  const paths = getGamePaths()

  if (!databaseHasTable(paths.dbPath, 'bannerlord_docs_fts')) {
    return textContent(
      renderAiTextReport('bannerlord_docs_search', 'query_text', query, [], [
        { key: 'index_status', value: 'missing' },
        { key: 'setup_hint', value: 'Run bun run index:own-docs first (external docs: bun run index:docs).' },
      ])
    )
  }

  const ftsQuery = buildFtsQuery(query)
  const sourceColumnValue = normalizeSourceFilter(source)
  const docRows = db
    .query<any, any>(
      `
      SELECT
        id,
        source,
        language,
        category,
        title,
        url,
        snippet(bannerlord_docs_fts, 6, '[', ']', ' ... ', 28) AS snippet
      FROM bannerlord_docs_fts
      WHERE bannerlord_docs_fts MATCH $query
        AND ($source IS NULL OR source = $source)
      ORDER BY bm25(bannerlord_docs_fts, 0.5, 0.5, 0.5, 2.0, 8.0, 0.1, 1.0)
      LIMIT $limit
    `
    )
    .all({
      $query: ftsQuery,
      $source: sourceColumnValue,
      $limit: clampLimit(limit),
    })

  const blocks: AiTextBlock[] = docRows.map((docRow, position) => ({
    header: `doc_match_${position + 1}`,
    fields: [
      { key: 'source', value: docRow.source },
      { key: 'language', value: docRow.language },
      { key: 'category', value: docRow.category },
      { key: 'title', value: docRow.title },
      { key: 'url', value: docRow.url },
    ],
    multilineFields: [{ key: 'snippet', value: docRow.snippet || '(no snippet)' }],
  }))

  return textContent(
    renderAiTextReport('bannerlord_docs_search', 'query_text', query, blocks, [
      { key: 'fts_query', value: ftsQuery },
      { key: 'source_filter', value: source },
      { key: 'index_status', value: 'ready' },
    ])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function textContent(text: string) {
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

/** Maps a filter name to its column value; an unknown name means "no filter". */
function normalizeSourceFilter(source: DocsSourceFilter): string | null {
  const columnValue = SOURCE_FILTER_COLUMNS.get(source)
  return columnValue ?? null
}

/** Non-finite limits fall back to the default; otherwise clamp to the page size. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return DOCS_DEFAULT_LIMIT
  }
  return Math.max(DOCS_MIN_LIMIT, Math.min(DOCS_MAX_LIMIT, Math.floor(limit)))
}
