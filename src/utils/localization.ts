/**
 * Localization resolution for `{=STRING_ID}fallback` tokens: pulls every
 * per-language entry from the index, orders them by the caller's language
 * preference, and exposes both a per-language map and a best-effort
 * display string that always shows the token id for traceability.
 *
 * Language naming in the wild is inconsistent (CNs / zh-Hans / SC / …),
 * so everything is folded through an alias table into canonical keys.
 */
import { getDb } from './db'

const TOKEN_REGEX = /^\{=([^}]+)\}(.*)$/

/** Alias table: canonical language -> accepted spellings (compared after
 * whitespace/underscore/hyphen stripping).
 *
 * Insertion order is load-bearing: getCanonicalLanguage() returns the FIRST
 * canonical whose alias list matches, so a spelling shared by two languages
 * resolves to whichever appears here first.
 */
const CANONICAL_LANGUAGE_ALIASES = new Map<string, string[]>([
  ['english', ['english', 'en']],
  [
    'chinese_simplified',
    [
      'cn',
      'cns',
      'chs',
      'sc',
      'zh',
      'zhcn',
      'zhhans',
      'zh-hans',
      'simplifiedchinese',
      'chinesesimplified',
    ],
  ],
  [
    'chinese_traditional',
    [
      'cnt',
      'cht',
      'tc',
      'zhtw',
      'zhhk',
      'zhhant',
      'zh-hant',
      'traditionalchinese',
      'chinesetraditional',
    ],
  ],
  ['portuguese', ['br', 'portuguese', 'pt', 'ptbr']],
  ['german', ['de', 'german']],
  ['french', ['fr', 'french']],
  ['italian', ['it', 'italian']],
  ['japanese', ['jp', 'japanese']],
  ['korean', ['ko', 'korean']],
  ['polish', ['pl', 'polish']],
  ['russian', ['ru', 'russian']],
  ['spanish', ['sp', 'es', 'spanish']],
  ['turkish', ['tr', 'turkish']],
])

/** Preference order applied after the caller's own list. */
const DEFAULT_LANGUAGE_PREFERENCE = ['chinese_simplified', 'chinese_traditional', 'english'] as const

/** Prefix that marks the English base files (`std_*`). */
const ENGLISH_BASE_PREFIX = 'std'

/** Separators that carry no meaning when comparing two language spellings. */
const MEANINGLESS_SEPARATORS = /[\s_-]+/g

export type LocalizationToken = {
  id: string
  fallback: string
}

export type XmlLocalizationEntry = {
  language: string
  text: string
  filePath?: string
}

export type SourceLocalizationEntry = {
  fallbackText: string
  filePath: string
  moduleName: string
  assemblyName: string
  lineNumber: number
  columnNumber: number
  contextKind: string
  sourcePriority: number
}

export type LocalizationDetails = {
  stringId: string
  tokenFallback?: string
  xmlEntries: XmlLocalizationEntry[]
  sourceEntries: SourceLocalizationEntry[]
}

/** Splits `{=ID}fallback` into its two halves; null for non-token text. */
export function parseLocalizationToken(text?: string | null): LocalizationToken | null {
  if (!text) return null
  const match = text.match(TOKEN_REGEX)
  if (!match) return null
  return {
    id: match[1],
    fallback: match[2] || '',
  }
}

/** Everything the index knows about one string id, preference-ordered. */
export function resolveLocalizationDetails(
  tokenOrId: string,
  preferredLanguages?: string[]
): LocalizationDetails {
  const token = parseLocalizationToken(tokenOrId)
  const id = token?.id || stripTokenPunctuation(tokenOrId)
  const db = getDb()

  const xmlEntries = readXmlEntries(db, id)
  const sourceEntries = readSourceEntries(db, id)

  xmlEntries.sort((left, right) => {
    const leftRank = getLocalizationLanguageRank(left.language, preferredLanguages)
    const rightRank = getLocalizationLanguageRank(right.language, preferredLanguages)
    const rankDelta = leftRank - rightRank

    if (rankDelta !== 0) {
      return rankDelta
    }

    const languageDelta = left.language.localeCompare(right.language)
    if (languageDelta !== 0) {
      return languageDelta
    }

    return (left.filePath || '').localeCompare(right.filePath || '')
  })

  return {
    stringId: id,
    tokenFallback: token?.fallback || undefined,
    xmlEntries,
    sourceEntries,
  }
}

/** The bare id inside `{=…}` when no token structure is present. */
function stripTokenPunctuation(tokenOrId: string): string {
  return tokenOrId.replace(/[{}=]/g, '').trim()
}

function readXmlEntries(db: ReturnType<typeof getDb>, id: string): XmlLocalizationEntry[] {
  return db
    .query<any, any>(
      `
      SELECT language, text, filePath
      FROM localization_entries
      WHERE stringId = $id
      ORDER BY language, filePath
    `
    )
    .all({
      $id: id,
    }) as XmlLocalizationEntry[]
}

/** The source-localization table only exists after the C# indexing pass;
 * probing avoids a hard failure on XML-only indexes. */
function readSourceEntries(db: ReturnType<typeof getDb>, id: string): SourceLocalizationEntry[] {
  if (!hasRuntimeTable('source_localization_entries')) {
    return []
  }

  return db
    .query<any, any>(
      `
      SELECT fallbackText, filePath, moduleName, assemblyName, lineNumber, columnNumber, contextKind, sourcePriority
      FROM source_localization_entries
      WHERE stringId = $id
      ORDER BY sourcePriority, moduleName, assemblyName, filePath, lineNumber, columnNumber
    `
    )
    .all({ $id: id }) as SourceLocalizationEntry[]
}

/** Language -> first text mapping, with canonical keys merged in; also
 * exposes the source-decompiled and token fallbacks under fixed keys. */
export function resolveLocalizationMap(
  tokenOrId: string,
  preferredLanguages?: string[]
): Record<string, string> {
  const details = resolveLocalizationDetails(tokenOrId, preferredLanguages)
  const mapping: Record<string, string> = {}

  for (const row of details.xmlEntries) {
    // First row wins per key: the SQL already ordered language, filePath, so
    // an existing entry is never overwritten.
    if (!mapping[row.language]) {
      mapping[row.language] = row.text
    }

    const canonical = getCanonicalLanguage(row.language)
    if (canonical && !mapping[canonical]) {
      mapping[canonical] = row.text
    }
  }

  const bestSourceEntry = details.sourceEntries[0]
  if (bestSourceEntry?.fallbackText && !mapping.sourceFallback) {
    mapping.sourceFallback = bestSourceEntry.fallbackText
  }

  if (details.tokenFallback && !mapping.fallback) {
    mapping.fallback = details.tokenFallback
  }

  return mapping
}

/** Display string for a possibly-tokenized text: the best available
 * translation, always suffixed with the token id for traceability. */
export function resolveMaybeLocalizedText(
  rawText: string | undefined,
  preferredLanguages?: string[]
): string {
  if (!rawText) return 'unknown'
  const token = parseLocalizationToken(rawText)
  if (!token) return rawText

  const mapping = resolveLocalizationMap(rawText, preferredLanguages)
  const preferred = buildPreferredLanguageOrder(preferredLanguages)
    .map(language => mapping[language])
    .find(Boolean)

  const finalText = preferred || mapping.sourceFallback || token.fallback
  if (!finalText) return rawText
  return `${finalText} ({=${token.id}})`
}

function hasRuntimeTable(tableName: string): boolean {
  const db = getDb()
  const row = db
    .query<{ name: string } | null, { $tableName: string }>(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = $tableName
      LIMIT 1
    `
    )
    .get({ $tableName: tableName })

  return Boolean(row)
}

/** Caller preferences first (canonicalized), then the hard-coded default
 * preference: simplified Chinese, traditional Chinese, English. */
function buildPreferredLanguageOrder(preferredLanguages?: string[]): string[] {
  const result: string[] = []

  for (const language of preferredLanguages ?? []) {
    const canonical = getCanonicalLanguage(language)
    // A language we cannot canonicalize contributes nothing, and a duplicate
    // spelling of one already in the list contributes nothing either.
    if (canonical && !result.includes(canonical)) {
      result.push(canonical)
    }
  }

  for (const fallback of DEFAULT_LANGUAGE_PREFERENCE) {
    if (!result.includes(fallback)) {
      result.push(fallback)
    }
  }

  return result
}

/** Sort rank for a language against the preference order; unknown
 * languages sort after every known one. */
function getLocalizationLanguageRank(language: string, preferredLanguages?: string[]): number {
  const canonical = getCanonicalLanguage(language)
  const order = buildPreferredLanguageOrder(preferredLanguages)
  const index = canonical ? order.indexOf(canonical) : -1
  const isUnranked = index === -1

  return isUnranked ? order.length + 1 : index
}

/** `std` files are the English base; then alias lookup; otherwise the
 * normalized key itself acts as its own canonical form. */
function getCanonicalLanguage(language: string): string | null {
  const normalized = normalizeLanguageKey(language)
  if (!normalized) {
    return null
  }

  if (normalized.startsWith(ENGLISH_BASE_PREFIX)) {
    return 'english'
  }

  for (const [canonical, aliases] of CANONICAL_LANGUAGE_ALIASES) {
    if (matchesLanguage(normalized, aliases)) {
      return canonical
    }
  }

  return normalized
}

function normalizeLanguageKey(language: string | undefined): string {
  const raw = language || ''
  return raw.trim().toLowerCase().replace(MEANINGLESS_SEPARATORS, '')
}

function matchesLanguage(normalizedLanguage: string, aliases: string[]): boolean {
  return aliases.some(alias => normalizeLanguageKey(alias) === normalizedLanguage)
}
