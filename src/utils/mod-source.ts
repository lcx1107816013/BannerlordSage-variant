/**
 * Locates and describes a mod source workspace: where the C# sources sit,
 * where its derived cache lives (sqlite index + AST dump + revision
 * marker), and how to enumerate the `.cs` files.
 *
 * The cache directory is keyed by a 12-hex digest of the lowercased,
 * forward-slashed source root — so the same workspace always maps to the
 * same cache regardless of path casing or separator style.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { distPath } from './env'

export type ModSourcePaths = {
  sourceDir: string
  sourceRoot: string
  workspaceId: string
  workspacePath: string
  cacheRoot: string
  dbPath: string
  csharpAstDumpPath: string
  versionPath: string
}

export type ModSourceWorkspace = ModSourcePaths & {
  workspaceRoot: string
}

/** Directory names never descended into when walking mod sources. */
export const MOD_SOURCE_IGNORED_DIRECTORY_NAMES = ['.git', '.idea', '.vs', '.vscode', 'bin', 'obj'] as const

const IGNORED_DIRECTORY_LOOKUP: ReadonlySet<string> = new Set(MOD_SOURCE_IGNORED_DIRECTORY_NAMES)

/** Environment spellings of the configured source directory, most specific first. */
const MOD_SOURCE_DIR_ENV_KEYS = [
  'BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR',
  'BANNERSAGE_MOD_SOURCE_DIR',
] as const

/** The configured source directory from the environment, if any. */
export function getConfiguredModSourceDir(): string | undefined {
  for (const envKey of MOD_SOURCE_DIR_ENV_KEYS) {
    const configured = process.env[envKey]
    if (configured) {
      return configured.trim()
    }
  }

  return undefined
}

/** Resolves (and creates the cache for) the configured workspace. */
export async function ensureModSourceDir(candidate?: string): Promise<string> {
  const paths = await resolveModSourceWorkspace(candidate)
  return paths.sourceRoot
}

/** Explicit candidate wins over the environment; blank everywhere throws. */
export function resolveModSourceDir(candidate?: string): string {
  const trimmedCandidate = candidate?.trim()
  const configured = trimmedCandidate || getConfiguredModSourceDir()
  if (!configured) {
    throw new Error('Missing mod source directory. Pass --source-dir "<path>" or set BANNERSAGE_MOD_SOURCE_DIR.')
  }

  return resolve(configured)
}

/** Full workspace resolution: validate the root, pick the effective source
 * root, create the cache directory. */
export async function resolveModSourceWorkspace(candidate?: string): Promise<ModSourceWorkspace> {
  const workspaceRoot = resolveModSourceDir(candidate)
  const workspaceStats = await statOrNull(workspaceRoot)
  if (!workspaceStats?.isDirectory()) {
    throw new Error(`Mod source path is not a directory: ${workspaceRoot}`)
  }

  const sourceRoot = await resolveEffectiveSourceRoot(workspaceRoot)
  const paths = getModSourcePaths(sourceRoot)

  await mkdir(paths.workspacePath, { recursive: true })

  return {
    ...paths,
    workspaceRoot,
  }
}

export function getModSourcePaths(sourceDir: string): ModSourcePaths {
  const normalizedSourceDir = resolve(sourceDir)
  const workspaceId = hashWorkspaceSourceRoot(normalizedSourceDir)
  const workspacePath = join(distPath, 'mod-sources', workspaceId)

  // sourceDir == sourceRoot by construction: the caller resolves the effective
  // root before asking for paths, so both fields describe the same directory.
  return {
    sourceDir: normalizedSourceDir,
    sourceRoot: normalizedSourceDir,
    workspaceId,
    workspacePath,
    cacheRoot: workspacePath,
    dbPath: join(workspacePath, 'mod-source.db'),
    csharpAstDumpPath: join(workspacePath, 'csharp-index.json'),
    versionPath: join(workspacePath, 'Version.txt'),
  }
}

/** 12 hex characters of sha1 over the case-folded, slash-normalized root. */
function hashWorkspaceSourceRoot(normalizedSourceDir: string): string {
  const canonical = normalizedSourceDir.replaceAll('\\', '/').toLowerCase()
  return createHash('sha1').update(canonical).digest('hex').slice(0, 12)
}

/** Counts `.cs` files under the root, honoring the skip list. */
export async function countModSourceCSharpFiles(sourceRoot: string): Promise<number> {
  let count = 0

  for await (const _filePath of walkModSourceCSharpFiles(sourceRoot)) {
    count += 1
  }

  return count
}

/** Depth-first async walk yielding every `.cs` file path. */
export async function* walkModSourceCSharpFiles(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })

  for (const entry of entries) {
    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      if (shouldSkipModSourceDirectory(entry.name)) {
        continue
      }

      yield* walkModSourceCSharpFiles(fullPath)
      continue
    }

    const isCSharpFile = entry.isFile() && entry.name.toLowerCase().endsWith('.cs')
    if (isCSharpFile) {
      yield fullPath
    }
  }
}

export function shouldSkipModSourceDirectory(name: string): boolean {
  return IGNORED_DIRECTORY_LOOKUP.has(name.trim().toLowerCase())
}

// A root named `src` is the source root itself; otherwise a nested `src`
// directory wins over the bare root (solution layout convention).
async function resolveEffectiveSourceRoot(workspaceRoot: string): Promise<string> {
  const isAlreadySourceRoot = basename(workspaceRoot).toLowerCase() === 'src'
  if (isAlreadySourceRoot) {
    return workspaceRoot
  }

  const nestedSourceRoot = join(workspaceRoot, 'src')
  const nestedStats = await statOrNull(nestedSourceRoot)
  if (nestedStats?.isDirectory()) {
    return nestedSourceRoot
  }

  return workspaceRoot
}

/** `stat` with every failure folded into null. */
async function statOrNull(path: string) {
  try {
    return await stat(path)
  } catch {
    return null
  }
}
