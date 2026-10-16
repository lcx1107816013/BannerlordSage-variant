// Filesystem layout for per-game indexed data.
//
// Everything the indexers and tools touch lives under `dist/games/<gameId>`,
// so swapping games means swapping one directory. The active game comes from
// the environment (`BANNERSAGE_GAME` / `BANNERLORDSAGE_GAME`); both spellings
// are accepted for compatibility with older launch scripts.
import { join } from 'path'

export const DEFAULT_GAME_ID = 'bannerlord'

/** Read in order; the first non-empty one wins. */
const GAME_ID_ENV_KEYS = ['BANNERSAGE_GAME', 'BANNERLORDSAGE_GAME'] as const

export const root = join(import.meta.dir, '../../')
export const distPath = join(root, 'dist')
export const gamesDistPath = join(distPath, 'games')

/** Trims and lowercases a game id, falling back to the default when empty. */
export function normalizeGameId(gameId?: string): string {
  const flattened = gameId?.trim().toLowerCase()
  if (flattened) {
    return flattened
  }

  return DEFAULT_GAME_ID
}

/** Reads the active game id from the environment. */
export function getActiveGameId(): string {
  let configured: string | undefined
  for (const envKey of GAME_ID_ENV_KEYS) {
    configured = process.env[envKey]
    if (configured) {
      break
    }
  }

  return normalizeGameId(configured)
}

/** Derives every well-known path for a game from its id. */
export function getGamePaths(gameId = getActiveGameId()) {
  const normalizedGameId = normalizeGameId(gameId)
  const gameDistPath = join(gamesDistPath, normalizedGameId)
  const assetsPath = join(gameDistPath, 'assets')
  const reportsPath = join(gameDistPath, 'reports')
  const underGameDist = (name: string) => join(gameDistPath, name)
  const underAssets = (name: string) => join(assetsPath, name)
  const underReports = (name: string) => join(reportsPath, name)

  return {
    gameId: normalizedGameId,
    gameDistPath,
    assetsPath,
    reportsPath,
    versionPath: underGameDist('Version.txt'),
    defsPath: underAssets('Xmls'),
    sourcePath: underAssets('Source'),
    dbPath: underGameDist(`${normalizedGameId}.db`),
    memoryDbPath: underGameDist(`${normalizedGameId}-memory.db`),
    setupStatePath: underGameDist('setup-state.json'),
    csharpAstDumpPath: underGameDist('csharp-index.json'),
    xmlParseReportPath: underReports('xml-parse-report.json'),
    xmlParseReportMarkdownPath: underReports('xml-parse-report.md'),
  }
}

// Resolved once at module load: the common case is one game per process.
export const activeGamePaths = getGamePaths(getActiveGameId())
export const activeGameId = activeGamePaths.gameId
export const assetsPath = activeGamePaths.assetsPath
export const versionPath = activeGamePaths.versionPath
export const defsPath = activeGamePaths.defsPath
export const sourcePath = activeGamePaths.sourcePath
export const dbPath = activeGamePaths.dbPath
export const memoryDbPath = activeGamePaths.memoryDbPath
export const setupStatePath = activeGamePaths.setupStatePath
export const csharpAstDumpPath = activeGamePaths.csharpAstDumpPath
