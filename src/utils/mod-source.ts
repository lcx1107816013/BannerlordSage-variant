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
import { readFileSync, writeFileSync } from 'node:fs'
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
  const configured = MOD_SOURCE_DIR_ENV_KEYS.map(envKey => process.env[envKey])
  // Most specific first: the first non-empty spelling wins, and when every
  // spelling is empty the LAST one is what the expression resolves to (an
  // empty string stays an empty string rather than collapsing to undefined).
  const effective = configured.find(candidate => candidate) ?? configured[configured.length - 1]
  return effective?.trim()
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
 * root, create the cache directory, and mark it as ours.
 *
 * ★ THE MARKER IS WRITTEN HERE, ON PURPOSE.
 *
 * This is the only place a workspace directory is created, so this is the only place
 * that can honestly say "this cache was built by this code". Writing it elsewhere
 * would mean a workspace could exist without a mark, which is the 'unknown' state —
 * the one that must never be deletable. Adding the mark here means every cache this
 * build creates is self-describing from its first byte.
 *
 * The write is best-effort: a failure means the workspace stays 'unknown' (i.e.
 * protected from deletion), which is the safe direction. Losing the marker must not
 * stop the caller from indexing. */
export async function resolveModSourceWorkspace(candidate?: string): Promise<ModSourceWorkspace> {
  const workspaceRoot = resolveModSourceDir(candidate)
  const workspaceStats = await statOrNull(workspaceRoot)
  if (!workspaceStats?.isDirectory()) {
    throw new Error(`Mod source path is not a directory: ${workspaceRoot}`)
  }

  const sourceRoot = await resolveEffectiveSourceRoot(workspaceRoot)
  const paths = getModSourcePaths(sourceRoot)

  await mkdir(paths.workspacePath, { recursive: true })

  // F19: classify before claiming. If a NEWER build wrote this workspace, this code
  // must not overwrite its marker (and must not treat the directory as its own).
  const existing = classifyModSourceWorkspace(paths.workspacePath)
  if (existing.kind !== 'stale-new') {
    try {
      writeModSourceWorkspaceMarker(paths.workspacePath, { sourceRoot })
    } catch {
      // leave it 'unknown': protected, still usable
    }
  }

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

// ── F19: a mechanical criterion for "is this cache ours to delete" ─────────
//
// THE HAZARD
// ----------
// `getModSourcePaths` derives the workspace directory from sha1(sourcePath), so a
// given path always maps to the same folder. That is convenient, and it is also why
// a naive "clean the cache" is dangerous: it can only see that
// `dist/mod-sources/<id>/` exists, not whether the code that wrote it was this code.
//
// Measured on this machine (tools/_probe_workspace_reach.ts, 2026-10-18): 18 folders
// hold a 3-column `csharp_files` (no `indexedAt`) written by an older build, 180 more
// are empty leftovers. None of the 64 source paths this code can actually see hash to
// one of those 18 — so the risk is structural but not currently reachable.
//
// That is precisely where a guard is cheap and a deletion is not. The marker is the
// criterion F19 asked for: only a workspace carrying OUR mark may be treated as ours.
//
// THE THIRD STATE MATTERS MOST
// ----------------------------
// 'stale-new' is a workspace written by a NEWER build. Deleting it would destroy data
// this code cannot even interpret. The first two states are the obvious ones; this is
// the one that makes the guard actually safe.
export const CURRENT_MOD_SOURCE_SCHEMA_VERSION = 2

/** File name of the marker written into every workspace we build. */
export const MOD_SOURCE_MARKER = 'workspace.json'

export type ModSourceWorkspaceKind =
  | 'current' // our marker, current version
  | 'stale-old' // our marker, older version: safe to rebuild
  | 'stale-new' // marker from a newer build: DO NOT TOUCH
  | 'unknown' // no marker, unreadable marker, or no directory: DO NOT TOUCH

export type ModSourceWorkspaceClass = {
  kind: ModSourceWorkspaceKind
  /** True only when this code may replace the directory's contents. */
  deletable: boolean
  /** Schema version recorded in the marker, when one could be read. */
  schemaVersion?: number
  /** Source root recorded in the marker, when one could be read. */
  sourceRoot?: string
  reason: string
}

/**
 * Classify a workspace directory. Never throws: an unreadable directory or a
 * malformed marker is 'unknown', because "I could not tell" must never be read as
 * permission to delete.
 */
export function classifyModSourceWorkspace(workspacePath: string): ModSourceWorkspaceClass {
  const markerPath = join(workspacePath, MOD_SOURCE_MARKER)

  let raw: string
  try {
    raw = readFileSync(markerPath, 'utf8')
  } catch {
    return {
      kind: 'unknown',
      deletable: false,
      reason: 'no workspace.json marker — this cache cannot be shown to be ours',
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      kind: 'unknown',
      deletable: false,
      reason: 'workspace.json is not valid JSON — cannot be shown to be ours',
    }
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {
      kind: 'unknown',
      deletable: false,
      reason: 'workspace.json is not an object',
    }
  }

  const record = parsed as { schemaVersion?: unknown; sourceRoot?: unknown }
  const version = record.schemaVersion
  if (typeof version !== 'number' || !Number.isFinite(version)) {
    return {
      kind: 'unknown',
      deletable: false,
      reason: 'workspace.json has no numeric schemaVersion',
    }
  }

  const sourceRoot = typeof record.sourceRoot === 'string' ? record.sourceRoot : undefined

  if (version === CURRENT_MOD_SOURCE_SCHEMA_VERSION) {
    return {
      kind: 'current',
      deletable: true,
      schemaVersion: version,
      sourceRoot,
      reason: `schema v${version}, current`,
    }
  }
  if (version < CURRENT_MOD_SOURCE_SCHEMA_VERSION) {
    return {
      kind: 'stale-old',
      deletable: true,
      schemaVersion: version,
      sourceRoot,
      reason: `schema v${version} < ${CURRENT_MOD_SOURCE_SCHEMA_VERSION}: ours, out of date`,
    }
  }
  return {
    kind: 'stale-new',
    deletable: false,
    schemaVersion: version,
    sourceRoot,
    reason:
      `schema v${version} > ${CURRENT_MOD_SOURCE_SCHEMA_VERSION}: written by a newer build, ` +
      'this code cannot interpret it and must not replace it',
  }
}

/**
 * Write the marker for a workspace this build just created. Called wherever a
 * workspace directory is created, so "ours" is a fact rather than an assumption.
 */
export function writeModSourceWorkspaceMarker(
  workspacePath: string,
  options: { sourceRoot: string; schemaVersion?: number },
): void {
  writeFileSync(
    join(workspacePath, MOD_SOURCE_MARKER),
    JSON.stringify(
      {
        schemaVersion: options.schemaVersion ?? CURRENT_MOD_SOURCE_SCHEMA_VERSION,
        sourceRoot: options.sourceRoot,
        writtenAt: new Date().toISOString(),
        writtenBy: 'bannerscribe-archive',
      },
      null,
      2,
    ),
    'utf8',
  )
}
