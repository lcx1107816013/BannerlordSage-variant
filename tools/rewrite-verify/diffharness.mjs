// Direct differential harness for rewritten files that no frozen fixture covers.
//
// WHY THIS EXISTS
// ---------------
// The frozen golden fixtures cover only part of src/tools. For the rest there is no
// pre-recorded expected output, so "behaviour unchanged" needs a different witness. The
// witness used here is the BASELINE ITSELF: the pre-rewrite revision of the same file,
// checked out from git into a shadow tree, imported side by side with the rewrite, and run
// over the same inputs. Both sides execute real code; the comparison is byte equality of
// the rendered text.
//
// The shadow copy keeps the tool-layer imports resolvable: a file checked out as
// src/tools/<name>.ts is written to src/tools/_baseline_shadow/<name>.ts and its relative
// specifiers are re-rooted one level deeper ('./x' -> '../x', '../utils/x' -> '../../utils/x').

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

// tools/rewrite-verify -> tools -> repo root, two levels up.
export const here = dirname(fileURLToPath(import.meta.url))
export const repoRoot = join(here, '..', '..')
export const BASELINE_REV = '8311c9a'

const SHADOW_DIR = join(repoRoot, 'src', 'tools', '_baseline_shadow')

/** Re-roots a relative specifier for one extra directory of depth. */
function deepen(spec) {
  return '../' + spec
}

/**
 * Materialises the baseline revision's version of `relPath` next to the live file, with
 * its relative imports re-rooted. Returns the absolute path of the shadow copy.
 */
export function prepareBaseline(relPath) {
  mkdirSync(SHADOW_DIR, { recursive: true })
  const raw = execFileSync('git', ['-C', repoRoot, 'show', `${BASELINE_REV}:${relPath}`], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const patched = raw.replace(
    /(from\s+|import\s*\()(['"])(\.\.?\/[^'"]*)\2/g,
    (whole, head, quote, spec) => `${head}${quote}${deepen(spec)}${quote}`
  )
  const target = join(SHADOW_DIR, relPath.split('/').pop())
  writeFileSync(target, patched, 'utf8')
  return target
}

/** Imports the baseline shadow and the live module for the same tool file. */
export async function loadBoth(relPath) {
  const shadow = prepareBaseline(relPath)
  const live = join(repoRoot, relPath)
  const baselineMod = await import(pathToFileURL(shadow).href + '?baseline=1')
  const liveMod = await import(pathToFileURL(live).href + '?live=1')
  return { baselineMod, liveMod, shadow, live }
}

export function cleanupShadow() {
  if (existsSync(SHADOW_DIR)) rmSync(SHADOW_DIR, { recursive: true, force: true })
}

export function report(file, problems, total) {
  if (problems.length === 0) {
    console.log(`OK    ${file}  (${total} cases, baseline vs rewrite byte-identical)`)
    return true
  }
  console.log(`DIFF  ${file}  (${problems.length}/${total} cases differ)`)
  for (const p of problems.slice(0, 5)) {
    console.log(`  case: ${p.label}`)
    console.log(`    baseline: ${p.baseText.slice(0, 400)}`)
    console.log(`    rewrite : ${p.liveText.slice(0, 400)}`)
  }
  return false
}

/** Runs one exported function from both revisions over `cases` and reports divergences. */
export async function compareFile(relPath, entryName, cases, call) {
  const { baselineMod, liveMod } = await loadBoth(relPath)
  const baseFn = baselineMod[entryName]
  const liveFn = liveMod[entryName]
  if (typeof baseFn !== 'function') {
    throw new Error(`baseline ${relPath} has no export ${entryName}`)
  }
  if (typeof liveFn !== 'function') {
    throw new Error(`rewrite ${relPath} has no export ${entryName}`)
  }

  const problems = []
  for (const c of cases) {
    let baseText, liveText
    try {
      baseText = JSON.stringify(await call(baseFn, c))
    } catch (error) {
      baseText = 'THREW ' + String(error?.message ?? error)
    }
    try {
      liveText = JSON.stringify(await call(liveFn, c))
    } catch (error) {
      liveText = 'THREW ' + String(error?.message ?? error)
    }
    if (baseText !== liveText) {
      problems.push({ label: c.label, baseText, liveText })
    }
  }
  return report(relPath, problems, cases.length)
}
