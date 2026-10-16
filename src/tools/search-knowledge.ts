import { PathSandbox } from '../utils/path-sandbox'
import { renderAiTextReport, type AiTextBlock } from '../utils/ai-text'
import { searchApiDocs } from './search-api-docs'
import { searchDocs } from './search-docs'
import { searchSource } from './search-source'

type KnowledgeIntent = 'auto' | 'make_mod' | 'api' | 'docs' | 'source'
type ResolvedIntent = Exclude<KnowledgeIntent, 'auto'>

/** Rows per page when the caller passes something unusable. */
const KNOWLEDGE_DEFAULT_LIMIT = 5
const KNOWLEDGE_MIN_LIMIT = 1
const KNOWLEDGE_MAX_LIMIT = 10

/** The usage rule echoed into every report. */
const SOURCE_AUTHORITY_RULE =
  'For Bannerlord mod implementation decisions, prefer local decompiled source when official API version does not exactly match the installed game.'

export async function searchKnowledge(
  sandbox: PathSandbox,
  query: string,
  intent: KnowledgeIntent = 'auto',
  limit = 5
) {
  const normalizedQuery = query.trim()
  const resolvedIntent = resolveIntent(normalizedQuery, intent)
  const pageSize = clampLimit(limit)

  // The four query builders below each rewrite the request for one backend, and
  // the same rewritten text is both what the backend is asked for and what the
  // report prints as the query that was used.
  const officialDocsQuery = buildOfficialDocsQuery(normalizedQuery, resolvedIntent)
  const communityDocsQuery = buildCommunityDocsQuery(normalizedQuery, resolvedIntent)
  const apiQuery = buildApiQuery(normalizedQuery, resolvedIntent)
  const sourceQuery = buildSourceQuery(normalizedQuery, resolvedIntent)

  const searchesDocs = shouldSearchDocs(resolvedIntent)
  const searchesApi = shouldSearchApi(resolvedIntent)
  const searchesSource = shouldSearchSource(resolvedIntent)

  const results: Array<{ label: string; payload?: Awaited<ReturnType<typeof safeSearch>> }> = [
    {
      label: 'own_knowledge',
      payload: searchesDocs
        ? await safeSearch('own_knowledge', () => searchDocs(normalizedQuery, 'own', pageSize))
        : undefined,
    },
    {
      label: 'official_docs',
      payload: searchesDocs
        ? await safeSearch('official_docs', () => searchDocs(officialDocsQuery, 'official', pageSize))
        : undefined,
    },
    {
      label: 'community_docs',
      payload: searchesDocs
        ? await safeSearch('community_docs', () => searchDocs(communityDocsQuery, 'community', pageSize))
        : undefined,
    },
    {
      label: 'official_api_docs',
      payload: searchesApi
        ? await safeSearch('official_api_docs', () => searchApiDocs(apiQuery, undefined, undefined, pageSize))
        : undefined,
    },
    {
      label: 'local_decompiled_source',
      payload: searchesSource
        ? await safeSearch('local_decompiled_source', () => searchSource(sandbox, sourceQuery, false, '*.cs'))
        : undefined,
    },
  ]

  const blocks: AiTextBlock[] = results
    .map(({ label, payload }) => buildResultBlock(label, payload))
    .filter((block): block is AiTextBlock => Boolean(block))

  const text = renderAiTextReport('bannerlord_knowledge_search', 'request_text', normalizedQuery, blocks, [
    { key: 'resolved_intent', value: resolvedIntent },
    { key: 'official_docs_query', value: searchesDocs ? officialDocsQuery : '(skipped)' },
    { key: 'community_docs_query', value: searchesDocs ? communityDocsQuery : '(skipped)' },
    { key: 'api_query', value: searchesApi ? apiQuery : '(skipped)' },
    { key: 'source_query', value: searchesSource ? sourceQuery : '(skipped)' },
    { key: 'docs_scope', value: searchesDocs ? 'own_knowledge_first_then_official_community' : 'skipped' },
    { key: 'api_scope', value: searchesApi ? 'official_api_symbols_reference_only_if_version_mismatch' : 'skipped' },
    { key: 'source_scope', value: searchesSource ? 'local_decompiled_source_authority' : 'skipped' },
    { key: 'usage_rule', value: SOURCE_AUTHORITY_RULE },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Runs one backend and never throws: a backend that fails becomes a payload
 * whose `ok` is false and whose text is the failure message, so one broken
 * source cannot take the whole layered search down.
 */
async function safeSearch(label: string, search: () => Promise<{ content: Array<{ type: 'text'; text: string }> }>): Promise<{
  label: string
  ok: boolean
  text: string
}> {
  try {
    const result = await search()
    return {
      label,
      ok: true,
      text: result.content.map(item => item.text).join('\n\n').trim(),
    }
  } catch (error) {
    return {
      label,
      ok: false,
      text: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * One source's outcome as a report block. A successful source carries its
 * nested report under `results`; a failed one carries the message under
 * `error`, so the two cases never look alike in the output.
 */
function buildResultBlock(resultLabel: string, result?: Awaited<ReturnType<typeof safeSearch>>): AiTextBlock | undefined {
  if (!result) {
    return undefined
  }

  return {
    header: resultLabel,
    fields: [
      { key: 'search_ok', value: result.ok },
      { key: 'source', value: result.label },
    ],
    multilineFields: [
      {
        key: result.ok ? 'results' : 'error',
        value: trimNestedReport(result.text),
      },
    ],
  }
}

function resolveIntent(query: string, intent: KnowledgeIntent): ResolvedIntent {
  if (intent !== 'auto') {
    return intent
  }

  const lower = query.toLowerCase()
  if (looksLikeApiQuestion(query)) {
    return 'api'
  }

  if (NAMEABLE_MOD_TOPIC.test(lower)) {
    return 'make_mod'
  }

  if (CHINESE_MOD_TOPIC.test(query)) {
    return 'make_mod'
  }

  // The default when nothing matched is still make_mod: an unrecognised request
  // is treated as a modding question rather than as an API one.
  return 'make_mod'
}

/** A call shape or an API vocabulary word means the caller wants the API docs. */
function looksLikeApiQuestion(query: string): boolean {
  return CALL_SHAPE.test(query) || API_VOCABULARY.test(query)
}

const CALL_SHAPE = /[a-z_][a-z0-9_.]*\s*\(/i
const API_VOCABULARY = /\b(api|class|method|property|event|enum|interface)\b/i
const NAMEABLE_MOD_TOPIC =
  /\b(harmony|patch|mod|module|submodule|gauntlet|ui|xml|asset|editor|campaignbehavior|behavior)\b/i
const CHINESE_MOD_TOPIC = /制作|开发|创建|做一个|做个|模组|mod|补丁|功能|界面|资源|编辑器|战役|行为/

function shouldSearchDocs(intent: ResolvedIntent): boolean {
  return intent === 'make_mod' || intent === 'docs'
}

function shouldSearchApi(intent: ResolvedIntent): boolean {
  return intent === 'make_mod' || intent === 'api'
}

function shouldSearchSource(intent: ResolvedIntent): boolean {
  return intent === 'make_mod' || intent === 'source' || intent === 'api'
}

/** The first matching topic token decides the official-docs query. */
function buildOfficialDocsQuery(query: string, intent: ResolvedIntent): string {
  if (intent === 'docs' || intent === 'make_mod') {
    const mapped = matchTopic(query, OFFICIAL_DOCS_TOPICS)
    if (mapped) {
      return mapped
    }
  }

  return query
}

/** Same shape as the official one, with its own topic table. */
function buildCommunityDocsQuery(query: string, intent: ResolvedIntent): string {
  if (intent === 'docs' || intent === 'make_mod') {
    const mapped = matchTopic(query, COMMUNITY_DOCS_TOPICS)
    if (mapped) {
      return mapped
    }
  }

  return query
}

/** Returns the replacement for the first pattern that matches, or '' if none does. */
function matchTopic(query: string, topics: Array<[RegExp, string]>): string {
  for (const [pattern, replacement] of topics) {
    if (pattern.test(query)) {
      return replacement
    }
  }
  return ''
}

// Order matters in both tables: the first match wins, so the more specific
// topics are listed before the broader ones.
const OFFICIAL_DOCS_TOPICS: Array<[RegExp, string]> = [
  [/gauntlet|ui|界面|菜单|窗口|按钮/i, 'Gauntlet UI'],
  [/asset|资源|模型|材质|覆盖|替换/i, '资产'],
  [/xml|数据|兵种|物品|文化|王国/i, 'XML'],
  [/submodule|模块|模组|mod|制作|创建|开发|quick/i, '快速入门'],
]

const COMMUNITY_DOCS_TOPICS: Array<[RegExp, string]> = [
  [/gauntlet|ui|界面|菜单|窗口|按钮/i, 'Gauntlet UI'],
  [/xml|数据|兵种|物品|文化|王国/i, 'SubModule XML'],
  [/harmony|patch|补丁|修改方法/i, 'Harmony'],
  [/asset|资源|模型|材质|覆盖|替换/i, 'asset'],
  [/submodule|模块|模组|mod|制作|创建|开发|quick/i, 'SubModule'],
]

/** A recognised topic on its own is worth more than the raw query. */
const API_TOPICS: Array<[RegExp, string]> = [
  [/gauntlet|ui|界面|菜单|窗口|按钮/i, 'Gauntlet'],
  [/xml|数据|读取|注册/i, 'MBObjectManager'],
  [/party|队伍|部队|俘虏|招募|士兵/i, 'MobileParty'],
  [/hero|领主|英雄|家族|clan/i, 'Hero'],
]

// The two defaults below are what an unmatched but mod-shaped query falls back to.
const API_FALLBACK_QUERY = 'CampaignBehavior'

function buildApiQuery(query: string, intent: ResolvedIntent): string {
  const symbol = extractLikelySymbol(query)
  if (symbol) {
    return symbol
  }

  if (intent === 'make_mod' || intent === 'api') {
    const mapped = matchTopic(query, API_TOPICS)
    if (mapped) {
      return mapped
    }
    return API_FALLBACK_QUERY
  }

  return query
}

function buildSourceQuery(query: string, intent: ResolvedIntent): string {
  const symbol = extractLikelySymbol(query)
  if (symbol) {
    return symbol
  }

  if (intent === 'make_mod' || intent === 'source' || intent === 'api') {
    const mapped = matchTopic(query, API_TOPICS)
    if (mapped) {
      return mapped
    }
    return API_FALLBACK_QUERY
  }

  // Outside a mod-shaped intent the source search still prefers an identifier
  // lifted out of the request over the request text itself.
  const englishWords = query.match(/[A-Za-z][A-Za-z0-9_.]{2,}/g)
  if (englishWords?.length) {
    return englishWords[0]
  }

  return query
}

/** The longest CamelCase candidate that is not one of the well-known acronyms. */
function extractLikelySymbol(query: string): string | undefined {
  const candidates = query.match(/\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*\b/g) ?? []
  return candidates
    .filter(candidate => !COMMON_ACRONYMS.has(candidate))
    .sort((left, right) => right.length - left.length)[0]
}

const COMMON_ACRONYMS = new Set(['Bannerlord', 'MCP', 'API', 'XML', 'UI'])

function trimNestedReport(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  const maxLines = 80
  const trimmed = lines.slice(0, maxLines).join('\n')
  return lines.length > maxLines ? `${trimmed}\n... truncated nested report ...` : trimmed
}

/** Non-finite limits fall back to the default; otherwise clamp to the page size. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return KNOWLEDGE_DEFAULT_LIMIT
  }
  return Math.max(KNOWLEDGE_MIN_LIMIT, Math.min(KNOWLEDGE_MAX_LIMIT, Math.floor(limit)))
}
