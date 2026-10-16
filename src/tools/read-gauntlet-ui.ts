// Gauntlet UI file inspector: finds an XML UI file by stem (prefix matching
// with a preference for gui/prefabs paths), then extracts the data sources
// and click commands so an agent can reason about the UI without opening
// the game. Results are cached per sandbox root and invalidated when the
// runtime revision changes (re-setup, game update).
import { Glob } from 'bun'
import { basename } from 'path'
import { renderAiTextReport, type AiTextBlock } from '../utils/ai-text'
import { PathSandbox } from '../utils/path-sandbox'
import { readTextFileLines } from '../utils/text-file-cache'
import { ensureRuntimeRevisionFresh, registerRuntimeInvalidator } from '../utils/runtime-revision'

const XML_GLOB = new Glob('**/*.xml')

/** Resolved path per (sandbox root, lowercased query). A miss is cached as null. */
const uiPathCache = new Map<string, string | null>()
/** The recursive XML scan per sandbox root, shared while it is still in flight. */
const uiIndexCache = new Map<string, Promise<string[]>>()

/** The two patterns whose group-1 captures become the report's lists. */
const DATA_SOURCE_PATTERN = /DataSource="{([^}]+)}"/g
const CLICK_COMMAND_PATTERN = /Command\.Click="([^"]+)"/g

/**
 * Ranking weights: a file under a GUI tree is a likelier match than one that
 * merely sits near a prefabs directory, so the more specific path wins. The
 * markers carry a LEADING slash and the paths are relative to the scan root,
 * so these only match when the file sits at least one directory down.
 */
const UI_MATCH_SCORES: Array<[string, number]> = [
  ['/gui/prefabs/', 30],
  ['/gui/', 20],
  ['/prefabs/', 10],
]
const UI_MATCH_DEFAULT_SCORE = 0

/** The extension stripped when deriving a file stem. */
const XML_SUFFIX = '.xml'

export async function readGauntletUi(sandbox: PathSandbox, uiFileName: string) {
  ensureRuntimeRevisionFresh()
  const normalizedQuery = uiFileName.trim()
  if (!normalizedQuery) {
    return oneBlock(
      renderAiTextReport('gauntlet_ui', 'ui_file_name', uiFileName, [], [
        { key: 'error', value: 'ui_file_name is required' },
      ])
    )
  }

  const foundPath = await resolveUiPath(sandbox, normalizedQuery)
  if (!foundPath) {
    return oneBlock(
      renderAiTextReport('gauntlet_ui', 'ui_file_name', normalizedQuery, [], [{ key: 'found', value: false }])
    )
  }

  const fullPath = sandbox.validateAndResolve(foundPath)
  const content = (await readTextFileLines(fullPath)).join('\n')

  const dataSources = collectMatches(content, DATA_SOURCE_PATTERN)
  const clickCommands = collectMatches(content, CLICK_COMMAND_PATTERN)

  const blocks: AiTextBlock[] = [
    {
      fields: [
        { key: 'file_path', value: foundPath },
        { key: 'file_name', value: basename(foundPath) },
        { key: 'data_source_count', value: dataSources.length },
        { key: 'click_command_count', value: clickCommands.length },
      ],
      listFields: [
        { key: 'data_sources', values: dataSources },
        { key: 'click_commands', values: clickCommands },
      ],
    },
  ]

  return oneBlock(
    renderAiTextReport('gauntlet_ui', 'ui_file_name', normalizedQuery, blocks, [{ key: 'found', value: true }])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function oneBlock(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

async function resolveUiPath(sandbox: PathSandbox, uiFileName: string): Promise<string | null> {
  const cacheKey = buildUiPathCacheKey(sandbox.basePath, uiFileName)
  if (uiPathCache.has(cacheKey)) {
    return uiPathCache.get(cacheKey) ?? null
  }

  const candidates = await getUiIndex(sandbox.basePath)
  const normalizedQuery = uiFileName.toLowerCase()

  // Exact stem wins outright; only when nothing matches exactly does the search
  // widen to a stem PREFIX. Both sets are then ranked the same way.
  const exactMatches = filterByStem(candidates, stem => stem === normalizedQuery)
  const rankedCandidates =
    exactMatches.length > 0
      ? exactMatches
      : filterByStem(candidates, stem => stem.startsWith(normalizedQuery))

  const bestMatch = rankUiMatches(rankedCandidates)[0] ?? null
  uiPathCache.set(cacheKey, bestMatch)
  return bestMatch
}

/** One cache entry per sandbox root and lowercased query. */
function buildUiPathCacheKey(basePath: string, uiFileName: string): string {
  return `${basePath}::${uiFileName.toLowerCase()}`
}

/** Keeps the candidates whose file stem satisfies `predicate`. */
function filterByStem(paths: string[], predicate: (stem: string) => boolean): string[] {
  return paths.filter(path => predicate(getXmlStem(path)))
}

async function getUiIndex(basePath: string): Promise<string[]> {
  const inFlight = uiIndexCache.get(basePath)
  if (inFlight) {
    // The in-flight PROMISE is shared rather than the array, so concurrent
    // callers for one root trigger exactly one directory walk.
    return await inFlight
  }

  const pending = buildUiIndex(basePath)
  uiIndexCache.set(basePath, pending)
  return await pending
}

async function buildUiIndex(basePath: string): Promise<string[]> {
  const results: string[] = []
  for await (const relativePath of XML_GLOB.scan({ cwd: basePath })) {
    // Paths are normalised to forward slashes so the score patterns below and
    // the emitted file_path read the same on every platform.
    results.push(relativePath.replaceAll('\\', '/'))
  }
  return results
}

/** Highest score first; equal scores fall back to a name comparison. */
function rankUiMatches(paths: string[]): string[] {
  return [...paths].sort((left, right) => {
    const scoreDelta = getUiMatchScore(right) - getUiMatchScore(left)
    if (scoreDelta !== 0) {
      return scoreDelta
    }
    return left.localeCompare(right)
  })
}

/** The first marker the path contains decides its score. */
function getUiMatchScore(path: string): number {
  const normalized = path.toLowerCase()
  const hit = UI_MATCH_SCORES.find(([marker]) => normalized.includes(marker))
  return hit ? hit[1] : UI_MATCH_DEFAULT_SCORE
}

/** The file name without its `.xml` extension, lowercased. */
function getXmlStem(path: string): string {
  const fileName = basename(path).toLowerCase()
  return fileName.endsWith(XML_SUFFIX) ? fileName.slice(0, -XML_SUFFIX.length) : fileName
}

/**
 * Group-1 captures, trimmed, DEDUPLICATED, in first-seen order. The pattern is
 * `g`-flagged and therefore stateful, so `lastIndex` is reset before scanning;
 * these patterns are module-level constants, and a scan abandoned mid-string
 * would otherwise make the next call start from the wrong place.
 */
function collectMatches(content: string, regex: RegExp): string[] {
  const values = new Set<string>()
  regex.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = regex.exec(content)) !== null) {
    const value = match[1]?.trim()
    if (value) {
      values.add(value)
    }
  }

  return [...values]
}

function clearGauntletUiCaches(): void {
  uiPathCache.clear()
  uiIndexCache.clear()
}

registerRuntimeInvalidator(() => {
  clearGauntletUiCaches()
})
