// Filesystem layout for per-game indexed data.
//
// Everything the indexers and tools touch lives under `dist/games/<gameId>`,
// so swapping games means swapping one directory. The active game comes from
// the environment (`BANNERSAGE_GAME` / `BANNERLORDSAGE_GAME`); both spellings
// are accepted for compatibility with older launch scripts.
import { join } from 'path'

export const DEFAULT_GAME_ID = 'bannerlord'

export const root = join(import.meta.dir, '../../')
export const distPath = join(root, 'dist')
export const gamesDistPath = join(distPath, 'games')

/** Trims and lowercases a game id, falling back to the default when empty. */
export function normalizeGameId(gameId?: string): string {
  const normalized = gameId?.trim().toLowerCase() || DEFAULT_GAME_ID
  return normalized || DEFAULT_GAME_ID
}

/** Reads the active game id from the environment. */
export function getActiveGameId(): string {
  return normalizeGameId(process.env.BANNERSAGE_GAME || process.env.BANNERLORDSAGE_GAME)
}

/** Derives every well-known path for a game from its id. */
export function getGamePaths(gameId = getActiveGameId()) {
  const normalizedGameId = normalizeGameId(gameId)
  const gameDistPath = join(gamesDistPath, normalizedGameId)
  const assetsPath = join(gameDistPath, 'assets')
  const reportsPath = join(gameDistPath, 'reports')

  return {
    gameId: normalizedGameId,
    gameDistPath,
    assetsPath,
    reportsPath,
    versionPath: join(gameDistPath, 'Version.txt'),
    defsPath: join(assetsPath, 'Xmls'),
    sourcePath: join(assetsPath, 'Source'),
    dbPath: join(gameDistPath, `${normalizedGameId}.db`),
    memoryDbPath: join(gameDistPath, `${normalizedGameId}-memory.db`),
    setupStatePath: join(gameDistPath, 'setup-state.json'),
    csharpAstDumpPath: join(gameDistPath, 'csharp-index.json'),
    xmlParseReportPath: join(reportsPath, 'xml-parse-report.json'),
    xmlParseReportMarkdownPath: join(reportsPath, 'xml-parse-report.md'),
  }
}

// Resolved once at module load: the common case is one game per process.
export const activeGameId = getActiveGameId()
export const activeGamePaths = getGamePaths(activeGameId)
export const assetsPath = activeGamePaths.assetsPath
export const versionPath = activeGamePaths.versionPath
export const defsPath = activeGamePaths.defsPath
export const sourcePath = activeGamePaths.sourcePath
export const dbPath = activeGamePaths.dbPath
export const memoryDbPath = activeGamePaths.memoryDbPath
export const setupStatePath = activeGamePaths.setupStatePath
export const csharpAstDumpPath = activeGamePaths.csharpAstDumpPath
