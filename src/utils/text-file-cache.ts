// LRU cache of recently read text files, sliced by line ranges.
//
// Entry validity is checked by (mtime, size); a global revision change
// (index re-run) drops the whole cache through the runtime-revision hook.
// Capacity is small on purpose — the call sites read a handful of hot files.
import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ensureRuntimeRevisionFresh, registerRuntimeInvalidator } from './runtime-revision'

type CachedTextFile = {
  fullPath: string
  mtimeMs: number
  size: number
  lines: string[]
}

type TextSlice = {
  text: string
  startLine: number
  endLineExclusive: number
  totalLines: number
  hasMore: boolean
}

const MAX_CACHED_FILES = 8
const cache = new Map<string, CachedTextFile>()

/** Reads a window of lines from a text file (1-based-friendly: line 0 = first line). */
export async function readTextFileSlice(
  fullPath: string,
  startLine = 0,
  lineCount = 400
): Promise<TextSlice> {
  ensureRuntimeRevisionFresh()
  const entry = await getCachedTextFile(fullPath)
  return windowOfEntry(entry, startLine, lineCount)
}

export async function readTextFileLines(fullPath: string): Promise<string[]> {
  ensureRuntimeRevisionFresh()
  const entry = await getCachedTextFile(fullPath)
  return entry.lines
}

export function clearTextFileCache(): void {
  cache.clear()
}

function windowOfEntry(entry: CachedTextFile, startLine: number, lineCount: number): TextSlice {
  const safeStart = Math.max(0, startLine)
  const safeCount = Math.max(1, lineCount)
  const totalLines = entry.lines.length
  const endLineExclusive = Math.min(safeStart + safeCount, totalLines)

  return {
    text: entry.lines.slice(safeStart, endLineExclusive).join('\n'),
    startLine: safeStart,
    endLineExclusive,
    totalLines,
    hasMore: endLineExclusive < totalLines,
  }
}

function isStillCurrent(cached: CachedTextFile, mtimeMs: number, size: number): boolean {
  return cached.mtimeMs === mtimeMs && cached.size === size
}

async function getCachedTextFile(fullPath: string): Promise<CachedTextFile> {
  const resolvedPath = resolve(fullPath)
  const stats = await stat(resolvedPath)
  const cached = cache.get(resolvedPath)

  if (cached !== undefined && isStillCurrent(cached, stats.mtimeMs, stats.size)) {
    refreshLru(resolvedPath, cached)
    return cached
  }

  const raw = await readFile(resolvedPath, 'utf8')
  const entry: CachedTextFile = {
    fullPath: resolvedPath,
    mtimeMs: stats.mtimeMs,
    size: stats.size,
    lines: raw.split(/\r?\n/),
  }

  refreshLru(resolvedPath, entry)
  return entry
}

// Map insertion order doubles as recency: re-insert on touch, evict the
// oldest key whenever capacity is exceeded.
function refreshLru(key: string, value: CachedTextFile): void {
  cache.delete(key)
  cache.set(key, value)

  while (cache.size > MAX_CACHED_FILES) {
    const oldest = cache.keys().next()
    const oldestKey = oldest.value
    if (!oldestKey) {
      break
    }
    cache.delete(oldestKey)
  }
}

registerRuntimeInvalidator(() => {
  clearTextFileCache()
})
