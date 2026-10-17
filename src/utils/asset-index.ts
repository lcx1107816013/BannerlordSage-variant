// Texture / material asset discovery across a Bannerlord install and its mods.
//
// WHY THIS EXISTS: the archive layer could already answer "which XML declares this item"
// and "which C# type reads it", but had no idea what artwork those declarations point at.
// A modder changing a shield's look needs to go from a material id or a texture filename to
// the file on disk - and no tool covered that half. This is the first piece of the
// asset-side capability the project goal called for.
//
// WHAT IT DELIBERATELY DOES NOT DO: it does not decode .dds/.tpac payloads. Parsing a DDS
// header is easy but parsing TPAC is a container format with its own versioning, and
// guessing at it would produce confident wrong answers - the exact failure this project
// keeps finding in other tools. Discovery is the part that can be made correct now, and it
// is the part a modder actually needs first: knowing WHICH file to open.
//
// TWO DIFFERENT KINDS OF ANSWER, KEPT APART:
//   * Asset packages  - `ModuleData/AssetPackages/*.tpac` and loose files under
//                       `AssetPackages/`. These are the shipped bundles.
//   * Loose artwork   - files under `GUI/`, `Textures/`, `Meshes/` etc. with art extensions.
//   Merging them would hide the fact that a texture found loose is not necessarily the one
//   the game loads, so the report keeps them in separate lists.

import type { Stats } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'
import { readdir, stat } from 'node:fs/promises'

/** Extensions that are artwork rather than data. Kept explicit so the list is auditable. */
export const TEXTURE_EXTENSIONS = ['.dds', '.png', '.jpg', '.jpeg', '.tga', '.bmp'] as const
export const MODEL_EXTENSIONS = ['.mesh', '.fbx', '.obj', '.dae', '.gltf', '.glb'] as const
export const PACKAGE_EXTENSIONS = ['.tpac'] as const

export type AssetKind = 'texture' | 'model' | 'package'

export type AssetEntry = {
  /** Path relative to the module directory - stable across machines. */
  relativePath: string
  absolutePath: string
  fileName: string
  extension: string
  kind: AssetKind
  sizeBytes: number
  /** Which module it belongs to, or 'unknown' when the walk started mid-tree. */
  moduleId: string
}

export type AssetIndexResult = {
  root: string
  entries: AssetEntry[]
  counts: Record<AssetKind, number>
  /** Directories skipped, so a surprising count has a visible explanation. */
  skippedDirectories: string[]
  truncated: boolean
}

function classify(extension: string): AssetKind | null {
  const ext = extension.toLowerCase()
  if ((TEXTURE_EXTENSIONS as readonly string[]).includes(ext)) return 'texture'
  if ((MODEL_EXTENSIONS as readonly string[]).includes(ext)) return 'model'
  if ((PACKAGE_EXTENSIONS as readonly string[]).includes(ext)) return 'package'
  return null
}

/**
 * Directories that never contain authored assets and can be large.
 * `.git` in particular made an early version of this walk take minutes on a mod repo.
 */
const PRUNE = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs', '.idea', '__pycache__'])

export type AssetIndexOptions = {
  /** Stop after this many entries; the result says so when it happened. */
  limit?: number
  /** Restrict to one module directory name under `Modules/`. */
  moduleId?: string
}

/**
 * Walks a game directory (or any module tree) collecting artwork and asset packages.
 *
 * Bounded on purpose: `limit` defaults to 5000 entries and `truncated` reports when it was
 * hit, because an unbounded recursive walk over a full install is the kind of thing that
 * looks fine on one machine and hangs on a bigger one.
 */
export async function indexAssets(
  gameDir: string,
  options: AssetIndexOptions = {},
): Promise<AssetIndexResult> {
  const limit = options.limit ?? 5000
  const entries: AssetEntry[] = []
  const skippedDirectories: string[] = []
  const brokenLinks: string[] = []
  let truncated = false

  const startDirs: Array<{ dir: string; moduleId: string }> = []
  const modulesDir = join(gameDir, 'Modules')

  if (options.moduleId) {
    startDirs.push({ dir: join(modulesDir, options.moduleId), moduleId: options.moduleId })
  } else {
    // Walk Modules/<id> so each entry can name its module, then the install-level art
    // directories, which belong to the game rather than to any single module.
    try {
      const moduleEntries = await readdir(modulesDir, { withFileTypes: true })
      for (const entry of moduleEntries) {
        if (!entry.isDirectory()) continue
        startDirs.push({ dir: join(modulesDir, entry.name), moduleId: entry.name })
      }
    } catch {
      // No Modules/ directory at all.
    }

    // ★ THE INSTALL-LEVEL TREE IS SEPARATE FROM THE MODULE TREES, AND THE FIRST VERSION
    // MISSED IT. Starting every walk inside `Modules/` meant a texture shipped at
    // `Bannerlord/GUI/Textures/...` - which is where the game keeps its own artwork - was
    // never seen. The boundary test caught it: the corpus put `GUI/Textures/Install.png` at
    // the root and the index came back without it.
    //
    // These are walked with moduleId 'game' rather than 'unknown', because they belong to a
    // specific thing - the install - and 'unknown' would read as "the walker lost track".
    for (const name of ['GUI', 'Textures', 'Meshes', 'AssetPackages']) {
      const candidate = join(gameDir, name)
      try {
        if ((await stat(candidate)).isDirectory()) {
          startDirs.push({ dir: candidate, moduleId: 'game' })
        }
      } catch {
        /* not present in this install */
      }
    }

    // Only when the install has neither Modules/ nor any known art directory does the whole
    // root get walked, which keeps the common case from re-scanning everything twice.
    if (startDirs.length === 0) startDirs.push({ dir: gameDir, moduleId: 'unknown' })
  }

  const walk = async (dir: string, moduleId: string): Promise<void> => {
    if (truncated) return
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      // Unreadable directory: recorded rather than thrown, because one bad ACL should not
      // lose the other 4000 results.
      skippedDirectories.push(join(dir))
      return
    }

    for (const dirent of dirents) {
      if (truncated) return
      const full = join(dir, dirent.name)

      // ★ VORTEX DEPLOYS BY SYMLINK, AND `dirent.isFile()` IS FALSE FOR A SYMLINK.
      //
      // Measured on a real install: `Modules\BannerFix\Assets\a1_geo.tpac` has
      // `Attributes: Archive, ReparsePoint`, `Length: 0`, `LinkType: SymbolicLink`, pointing into
      // `%APPDATA%\Vortex\...`. Node's Dirent reports such an entry as NEITHER a file NOR a
      // directory - `isFile()`, `isDirectory()` and `isSymbolicLink()` are all checks against the
      // link itself, and the first two are false for it.
      //
      // The original code did `if (!dirent.isFile()) continue`, so every symlinked asset was
      // silently dropped. On that install it lost 9 of 12 art-bearing modules entirely while the
      // aggregate count still looked healthy (1628 entries) - because the base game's own packages
      // are real files and carried the number.
      //
      // This is the SAME blind spot the project's `walkFiles` fix addressed for the doctor (39
      // false positives from invisible Vortex installs). Re-introducing it in new code is exactly
      // the kind of regression a corpus built from assumptions cannot catch: my test corpus used
      // writeFileSync, which produces real files.
      //
      // `stat` follows the link, which is what we want here: the deployed mod's content IS the
      // asset. A broken link makes stat throw, and it is recorded rather than dropped silently.
      // ★ `STAT` MUST COME FIRST, AND THE FIRST ATTEMPT GOT THIS BACKWARDS.
      //
      // The rewrite classified the extension before following the link, which meant a DIRECTORY
      // whose name has no asset extension (`GUI`, `Assets`, `ModuleData`) hit `if (!kind) continue`
      // and its entire subtree was never walked. Measured: the install went from 1628 entries to
      // 1. Directories have to be resolved before anything is decided about their names.
      let followed: Stats
      try {
        followed = await stat(full)
      } catch {
        brokenLinks.push(full)
        continue
      }

      if (followed.isDirectory()) {
        if (PRUNE.has(dirent.name)) {
          skippedDirectories.push(full)
          continue
        }
        await walk(full, moduleId)
        continue
      }
      if (!followed.isFile()) continue

      const kind = classify(extname(dirent.name))
      if (!kind) continue

      if (entries.length >= limit) {
        truncated = true
        return
      }

      let sizeBytes = 0
      try {
        // The link's own size is 0; the target's size is the useful number, and `stat` already
        // resolved it. Reading it from `followed` avoids a second syscall.
        sizeBytes = followed.size
      } catch {
        /* size is advisory */
      }

      entries.push({
        relativePath: relative(dir.startsWith(gameDir) ? gameDir : dir, full).split('\\').join('/'),
        absolutePath: full,
        fileName: basename(full),
        extension: extname(dirent.name).toLowerCase(),
        kind,
        sizeBytes,
        moduleId,
      })
    }
  }

  for (const { dir, moduleId } of startDirs) {
    if (truncated) break
    try {
      const info = await stat(dir)
      if (!info.isDirectory()) continue
    } catch {
      continue
    }
    await walk(dir, moduleId)
  }

  const counts = { texture: 0, model: 0, package: 0 } as Record<AssetKind, number>
  for (const entry of entries) counts[entry.kind]++

  return { root: gameDir, entries, counts, skippedDirectories, brokenLinks, truncated }
}

/** Case-insensitive substring match over filename and relative path. */
export function findAssets(index: AssetIndexResult, query: string): AssetEntry[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  return index.entries.filter(
    entry =>
      entry.fileName.toLowerCase().includes(needle)
      || entry.relativePath.toLowerCase().includes(needle)
      || entry.moduleId.toLowerCase().includes(needle),
  )
}
