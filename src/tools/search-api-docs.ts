// FTS5 search over the indexed decompiled-API docs, versioned against the
// installed game. Falls back to a LIKE scan when the FTS query matches
// nothing (short tokens, symbols), and surfaces version-resolution details
// so stale-index situations are visible instead of silent.
import { databaseHasTable, getDb } from '../utils/db'
import { getGamePaths } from '../utils/env'
import { renderAiTextReport, type AiTextBlock } from '../utils/ai-text'
import { loadSetupStateForGame } from '../utils/bannerlord-setup'
import {
  BANNERLORD_API_SECTIONS,
  resolveBannerlordApiVersion,
  type BannerlordApiSection,
} from '../utils/bannerlord-api-docs'

/** Rows per page when the caller passes something unusable. */
const API_DEFAULT_LIMIT = 10
const API_MIN_LIMIT = 1
const API_MAX_LIMIT = 30

export async function searchApiDocs(
  query: string,
  version?: string,
  section?: BannerlordApiSection,
  limit = 10
) {
  const db = getDb('bannerlord')
  const paths = getGamePaths('bannerlord')
  const state = await loadSetupStateForGame('bannerlord')

  if (!databaseHasTable(paths.dbPath, 'bannerlord_api_entries_fts')) {
    return textContent(
      renderAiTextReport('bannerlord_api_search', 'query_text', query, [], [
        { key: 'index_status', value: 'missing' },
        { key: 'setup_hint', value: 'Run bun run index:api-docs first.' },
        { key: 'installed_game_version', value: state.gameVersion || '(unknown)' },
        { key: 'installed_full_version', value: state.fullVersion || '(unknown)' },
        { key: 'authority', value: 'local_decompiled_source' },
      ])
    )
  }

  const resolution = resolveBannerlordApiVersion(db, state, version)
  if (!resolution.selectedApiVersion) {
    return textContent(
      renderAiTextReport('bannerlord_api_search', 'query_text', query, [], [
        { key: 'index_status', value: 'ready' },
        { key: 'installed_game_version', value: resolution.installedGameVersion || '(unknown)' },
        { key: 'installed_full_version', value: resolution.installedFullVersion || '(unknown)' },
        { key: 'requested_api_version', value: resolution.requestedApiVersion || '(none)' },
        { key: 'authority', value: resolution.authority },
        { key: 'version_warning', value: resolution.warning || '(none)' },
        { key: 'available_versions', value: resolution.availableVersions.join(', ') || '(none)' },
      ])
    )
  }

  const ftsQuery = buildFtsQuery(query)
  const selectedVersion = resolution.selectedApiVersion
  const sectionFilter = normalizeSection(section)
  const pageSize = clampLimit(limit)
  const ftsRows = runFtsLookup(db, ftsQuery, selectedVersion, sectionFilter, pageSize)

  // FTS5 phrase matching misses short or symbol-heavy tokens; the LIKE path
  // is the safety net, ordered exact > prefix > anything.
  const usedLikeFallback = ftsRows.length === 0
  const rows = usedLikeFallback
    ? runLikeLookup(db, query, selectedVersion, sectionFilter, pageSize)
    : ftsRows

  const blocks: AiTextBlock[] = rows.map((apiRow, position) => ({
    header: `api_match_${position + 1}`,
    fields: [
      { key: 'api_version', value: apiRow.version },
      { key: 'section', value: apiRow.section },
      { key: 'title', value: apiRow.title },
      { key: 'scope', value: apiRow.scope || '(none)' },
      { key: 'url', value: apiRow.url },
    ],
    multilineFields: [
      { key: 'title_snippet', value: apiRow.titleSnippet || apiRow.title },
      { key: 'scope_snippet', value: apiRow.scopeSnippet || apiRow.scope || '(none)' },
    ],
  }))

  return textContent(
    renderAiTextReport('bannerlord_api_search', 'query_text', query, blocks, [
      { key: 'fts_query', value: ftsQuery },
      { key: 'index_status', value: 'ready' },
      { key: 'installed_game_version', value: resolution.installedGameVersion || '(unknown)' },
      { key: 'installed_full_version', value: resolution.installedFullVersion || '(unknown)' },
      { key: 'requested_api_version', value: resolution.requestedApiVersion || '(none)' },
      { key: 'official_api_version_used', value: resolution.selectedApiVersion },
      { key: 'api_exact_match', value: resolution.exactMatch },
      { key: 'authority', value: resolution.authority },
      { key: 'api_usage', value: resolution.usage },
      { key: 'version_warning', value: resolution.warning || '(none)' },
    ])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function textContent(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** The ranked FTS5 lookup; empty when the phrase query found no documents. */
function runFtsLookup(db: ReturnType<typeof getDb>, ftsQuery: string, version: string, section: string | null, limit: number) {
  return db
    .query<any, any>(
      `
      SELECT
        id,
        version,
        section,
        searchKey,
        title,
        scope,
        url,
        snippet(bannerlord_api_entries_fts, 4, '[', ']', ' ... ', 18) AS titleSnippet,
        snippet(bannerlord_api_entries_fts, 5, '[', ']', ' ... ', 18) AS scopeSnippet
      FROM bannerlord_api_entries_fts
      WHERE bannerlord_api_entries_fts MATCH $query
        AND version = $version
        AND ($section IS NULL OR section = $section)
      ORDER BY bm25(bannerlord_api_entries_fts, 0.5, 0.5, 0.5, 4.0, 8.0, 2.0, 0.1, 6.0)
      LIMIT $limit
    `
    )
    .all({ $query: ftsQuery, $version: version, $section: section, $limit: limit })
}

/**
 * The LIKE safety net over the plain table. The snippet columns are the raw
 * values because there is no FTS row behind this path.
 */
function runLikeLookup(db: ReturnType<typeof getDb>, query: string, version: string, section: string | null, limit: number) {
  const plainQuery = query.trim()
  return db
    .query<any, any>(
      `
      SELECT
        id,
        version,
        section,
        searchKey,
        title,
        scope,
        url,
        title AS titleSnippet,
        scope AS scopeSnippet
      FROM bannerlord_api_entries
      WHERE version = $version
        AND ($section IS NULL OR section = $section)
        AND (
          title LIKE $likeQuery ESCAPE '\\'
          OR searchKey LIKE $likeQuery ESCAPE '\\'
          OR scope LIKE $likeQuery ESCAPE '\\'
        )
      ORDER BY
        CASE
          WHEN title = $plainQuery THEN 0
          WHEN title LIKE $prefixQuery THEN 1
          ELSE 2
        END,
        title
      LIMIT $limit
    `
    )
    .all({
      $version: version,
      $section: section,
      $plainQuery: plainQuery,
      $prefixQuery: `${plainQuery}%`,
      $likeQuery: `%${escapeLikePattern(plainQuery)}%`,
      $limit: limit,
    })
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

/** Only a section the index actually carries is worth filtering on. */
function normalizeSection(section?: BannerlordApiSection): BannerlordApiSection | null {
  if (!section) return null
  return BANNERLORD_API_SECTIONS.includes(section) ? section : null
}

/** Non-finite limits fall back to the default; otherwise clamp to the page size. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return API_DEFAULT_LIMIT
  }
  return Math.max(API_MIN_LIMIT, Math.min(API_MAX_LIMIT, Math.floor(limit)))
}

/** `%` and `_` are wildcards in a LIKE pattern and become literals here. */
function escapeLikePattern(value: string): string {
  return value.replace(/[%_]/g, match => `\\${match}`)
}
