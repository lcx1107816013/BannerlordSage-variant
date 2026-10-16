// MCP tool: index a Bannerlord install's artwork and asset packages.
//
// This is the entry point for the asset-side capability the project goal called for: given
// a game directory (or one module inside it), report every texture, model and .tpac bundle
// so a modder can find WHICH file to open before changing anything.
//
// WHAT IT REFUSES TO DO: it does not decode DDS or TPAC payloads. Discovery is the part that
// can be made correct with the information available; guessing at TPAC's container layout
// would produce confident wrong answers, which is the failure mode this project keeps
// finding elsewhere. The tool says what exists and where, and stops there.
//
// THE REPORT KEEPS TWO THINGS APART that look similar and are not: shipped bundles
// (`AssetPackages/*.tpac`) and loose artwork (`GUI/`, `Textures/`, `Meshes/`). A loose
// texture is not necessarily the one the game loads, so merging the lists would imply it is.

import { stat } from 'node:fs/promises'

import { renderAiTextReport } from '../utils/ai-text'
import { indexAssets, findAssets, type AssetIndexResult } from '../utils/asset-index'

/** Returns true when the path is a readable directory; false when absent; throws otherwise. */
async function statDirectory(path: string): Promise<boolean> {
  const info = await stat(path)
  return info.isDirectory()
}

export type IndexAssetsInput = {
  /** Game install directory. */
  gameDir: string
  /** Restrict to one module under `Modules/`. */
  moduleId?: string
  /** Substring filter over filename, relative path and module id. */
  query?: string
  /** Stop after this many entries; the report states when it was hit. */
  limit?: number
}

export async function indexAssetsTool(input: IndexAssetsInput) {
  const { gameDir, moduleId, query, limit } = input

  const trimmedDir = (gameDir ?? '').trim()
  if (!trimmedDir) {
    return report(trimmedDir, [
      { key: 'error', value: 'gameDir is required' },
    ])
  }

  // ★ A MISSING DIRECTORY MUST NOT LOOK LIKE AN EMPTY ONE. The walker returns zero entries
  // for a path that does not exist (its readdir failures are recorded as skipped
  // directories), so without this check the tool answered "0 textures, 0 models" for a typo
  // in the install path - and a caller reading that concludes the install has no artwork.
  // The failure mode this project keeps finding is exactly this shape: a report that looks
  // successful and describes the wrong thing.
  let stat
  try {
    stat = await statDirectory(trimmedDir)
  } catch (error) {
    return report(trimmedDir, [
      { key: 'error', value: `gameDir is not a readable directory: ${trimmedDir}` },
      { key: 'detail', value: error instanceof Error ? error.message : String(error) },
    ])
  }
  if (!stat) {
    return report(trimmedDir, [
      { key: 'error', value: `gameDir is not a directory: ${trimmedDir}` },
    ])
  }

  let index: AssetIndexResult
  try {
    index = await indexAssets(trimmedDir, { moduleId, limit })
  } catch (error) {
    // A missing or unreadable install is a normal outcome to report, not a crash: the
    // caller usually has the path from configuration and needs to be told it is wrong.
    return report(trimmedDir, [
      { key: 'error', value: `could not read ${trimmedDir}` },
      { key: 'detail', value: error instanceof Error ? error.message : String(error) },
    ])
  }

  const shown = query && query.trim() ? findAssets(index, query) : index.entries

  const packages = shown.filter(entry => entry.kind === 'package')
  const textures = shown.filter(entry => entry.kind === 'texture')
  const models = shown.filter(entry => entry.kind === 'model')

  // Listing names rather than counts: a count tells you the walk worked, a name tells you
  // which file to open, and the second one is what the caller came for.
  const nameOf = (entry: { relativePath: string; moduleId: string }) =>
    `${entry.relativePath}  [${entry.moduleId}]`

  return report(
    trimmedDir,
    [
      { key: 'root', value: index.root },
      { key: 'texture_count', value: textures.length },
      { key: 'model_count', value: models.length },
      { key: 'package_count', value: packages.length },
      { key: 'total_indexed', value: index.entries.length },
      ...(query ? [{ key: 'query', value: query }] : []),
    ],
    [
      { key: 'asset_packages', values: packages.map(nameOf) },
      { key: 'textures', values: textures.map(nameOf) },
      { key: 'models', values: models.map(nameOf) },
      {
        key: 'notes',
        values: [
          'Payloads are not decoded: this lists what exists, not what is inside.',
          'A loose texture is not necessarily the one the game loads for a given material.',
          ...(index.truncated
            ? [`Truncated at ${index.entries.length} entries; raise limit for the rest.`]
            : []),
          ...(index.skippedDirectories.length > 0
            ? [`Skipped ${index.skippedDirectories.length} directories (build output, VCS, dependencies).`]
            : []),
        ],
      },
    ],
  )
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
        text: renderAiTextReport('index_assets', 'gameDir', queryValue, [{ fields, listFields: lists }], []),
      },
    ],
  }
}
