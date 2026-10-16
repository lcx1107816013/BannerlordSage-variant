// MCP tool: find one artwork file by name, path fragment or module id.
//
// WHY A SEPARATE TOOL WHEN `index_assets` ALREADY TAKES A QUERY
// -------------------------------------------------------------
// They answer different questions, and the difference is the whole reason both exist:
//
//   index_assets  "what artwork does this install have?"   -> an inventory, counts first
//   find_asset    "where is the file I already named?"     -> a lookup, best matches first
//
// Collapsing them would mean the inventory tool has to guess whether the caller wanted a
// survey or a hit, and it would answer a lookup with a full listing nearly every time. The
// two also differ in what they do with an empty query: the inventory tool treats it as "no
// filter", while a lookup with no needle is a caller mistake and says so.
//
// Matching is case-insensitive over filename, relative path and module id, ranked so an
// exact filename beats a path substring - the common case is knowing the file's name and
// wanting its location, and that answer should be first, not buried under path matches.

import { stat } from 'node:fs/promises'

import { renderAiTextReport } from '../utils/ai-text'
import { indexAssets, type AssetEntry } from '../utils/asset-index'

export type FindAssetInput = {
  gameDir: string
  query: string
  moduleId?: string
  limit?: number
}

/** Ranks a match so the most obviously-intended answer is first. */
function score(entry: AssetEntry, needle: string): number {
  const name = entry.fileName.toLowerCase()
  if (name === needle) return 100
  if (name.startsWith(needle)) return 80
  if (name.includes(needle)) return 60
  if (entry.relativePath.toLowerCase().includes(needle)) return 40
  if (entry.moduleId.toLowerCase().includes(needle)) return 20
  return 0
}

export async function findAssetTool(input: FindAssetInput) {
  const needle = (input.query ?? '').trim().toLowerCase()
  if (!needle) {
    // An empty needle would match everything, which looks like a successful lookup and is
    // actually an unasked question. Saying so is more useful than returning the whole tree.
    return report(input.query ?? '', [{ key: 'error', value: 'query is required' }])
  }

  const gameDir = (input.gameDir ?? '').trim()
  if (!gameDir) {
    return report(needle, [{ key: 'error', value: 'gameDir is required' }])
  }

  // ★ "NO MATCHES" AND "BAD PATH" MUST NOT LOOK THE SAME. The walker returns zero entries
  // for a path that does not exist, so without this check a typo in the install path
  // produced `match_count: 0` - indistinguishable from a real lookup that found nothing.
  // Checking the directory first is what separates "the file is not here" from "this is not
  // where you think it is".
  try {
    const info = await stat(gameDir)
    if (!info.isDirectory()) {
      return report(needle, [{ key: 'error', value: `gameDir is not a directory: ${gameDir}` }])
    }
  } catch (error) {
    return report(needle, [
      { key: 'error', value: `gameDir is not a readable directory: ${gameDir}` },
      { key: 'detail', value: error instanceof Error ? error.message : String(error) },
    ])
  }

  let index
  try {
    index = await indexAssets(gameDir, { moduleId: input.moduleId })
  } catch (error) {
    return report(needle, [
      { key: 'error', value: `could not read ${gameDir}` },
      { key: 'detail', value: error instanceof Error ? error.message : String(error) },
    ])
  }

  const matches = index.entries
    .map(entry => ({ entry, rank: score(entry, needle) }))
    .filter(hit => hit.rank > 0)
    // Ties broken by path so repeated runs produce the same order; an unstable result makes
    // every diff look like a change.
    .sort((a, b) => (b.rank - a.rank) || a.entry.relativePath.localeCompare(b.entry.relativePath))
    .slice(0, input.limit ?? 50)
    .map(hit => hit.entry)

  const lines = matches.map(
    entry => `${entry.relativePath}  [${entry.moduleId}]  ${entry.kind}  ${entry.sizeBytes} bytes`,
  )

  return report(needle, [
    { key: 'game_dir', value: index.root },
    { key: 'match_count', value: matches.length },
    { key: 'total_indexed', value: index.entries.length },
    ...(matches.length === 0
      ? [{ key: 'result', value: 'no matches in the indexed tree' }]
      : []),
  ], [{ key: 'matches', values: lines }])
}

function report(
  queryValue: string,
  fields: Array<{ key: string; value: string | number | boolean }>,
  lists: Array<{ key: string; values: string[] }> = [],
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: renderAiTextReport('find_asset', 'query', queryValue, [{ fields, listFields: lists }], []),
      },
    ],
  }
}
