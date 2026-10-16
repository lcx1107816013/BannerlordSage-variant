// Direct baseline-vs-rewrite differential for read-gauntlet-ui.ts — its ONLY witness.
//
// No frozen fixture touches this tool. Its selection logic is the part a re-implementation can
// silently break: exact-stem-then-prefix, the /gui/prefabs/ > /gui/ > /prefabs/ > elsewhere
// ranking, the localeCompare tie-break, case folding, recursive walking, and the two deduping
// extraction regexes. gauntlet-tree.mjs builds a corpus that separates each of those rules.
//
// ★ THE CACHES ARE THE HARD PART, AND THEY ARE DELIBERATELY EXERCISED.
//   uiPathCache and uiIndexCache are module-level, so a case list that only ever asks for new
//   names never touches the hit paths. Two things keep this honest:
//     1. The case list asks for the SAME name twice, so a cached hit is compared too.
//     2. Each side gets its own module instance (via a cache-busting import query), so one
//        side's cache cannot answer for the other.
//   A third property is asserted directly below: the cache key is lowercased and includes the
//   base path, so the same query in two DIFFERENT sandboxes must resolve independently.
//
// Usage: bun run tools/rewrite-verify/diff_gauntlet.mjs

import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { repoRoot, prepareBaseline, cleanupShadow, report } from './diffharness.mjs'
import { buildGauntletTree, GAUNTLET_ROOT } from './gauntlet-tree.mjs'

const root = buildGauntletTree()

// A SECOND tree, so the per-base-path cache key is exercised rather than assumed.
const rootB = join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'gauntlet-ui-b')
rmSync(rootB, { recursive: true, force: true })
mkdirSync(join(rootB, 'gui'), { recursive: true })
writeFileSync(
  join(rootB, 'gui', 'Widget.xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n<Prefab>\n  <Widget DataSource="{OnlyInB}" />\n</Prefab>\n',
  'utf8'
)

cleanupShadow()

// Each side gets its OWN module instance. A cache-busting query on the import specifier does
// that; without it both sides would share one module and one cache.
async function loadSide(revTag) {
  const shadowPath = prepareBaseline('src/tools/read-gauntlet-ui.ts')
  const livePath = join(repoRoot, 'src', 'tools', 'read-gauntlet-ui.ts')
  const mod = await import(
    pathToFileURL(revTag === 'base' ? shadowPath : livePath).href + `?gside=${revTag}`
  )
  if (typeof mod.readGauntletUi !== 'function') {
    throw new Error(`${revTag} read-gauntlet-ui.ts has no readGauntletUi export`)
  }
  return mod.readGauntletUi
}

const baseFn = await loadSide('base')
const liveFn = await loadSide('live')

const { PathSandbox } = await import(
  pathToFileURL(join(repoRoot, 'src', 'utils', 'path-sandbox.ts')).href + '?gshared=1'
)

// Cases run in ORDER against a single module instance per side, so repeated names are genuine
// cache hits and the second sandbox is a genuine separate cache entry.
const CASES = [
  { label: 'exact stem', sandbox: root, name: 'Widget' },
  { label: 'exact stem again (cache hit)', sandbox: root, name: 'Widget' },
  { label: 'exact stem, different case (cache hit key is lowercased)', sandbox: root, name: 'WIDGET' },
  { label: 'exact stem, padded (trimmed before lookup)', sandbox: root, name: '  Widget  ' },
  // ── ★★ THE RANKING CASES. One stem, four exact-stem candidates at four scores, so the
  //    WINNER identifies which score was applied. Mutating a score constant changes which
  //    file wins and therefore fails these cases. ──
  { label: 'RANK DECIDES: RankShared resolves to the 30-point /gui/prefabs copy', sandbox: root, name: 'RankShared' },
  // ── the three scored ranks on their own, so each marker is reachable independently ──
  { label: 'RANK 30 alone: assets/gui/prefabs/PanelPrefab', sandbox: root, name: 'PanelPrefab' },
  { label: 'RANK 20 alone: assets/gui/PanelGui', sandbox: root, name: 'PanelGui' },
  { label: 'RANK 10 alone: assets/prefabs/PanelBare', sandbox: root, name: 'PanelBare' },
  { label: 'RANK 0 alone: unmatched path still resolves', sandbox: root, name: 'PanelPlain' },
  // ── the measured trap: a path that STARTS with gui/ still scores 0, because the
  //    markers carry a leading slash and the scan root is relative ──
  { label: 'TRAP: gui/PanelRel.xml scores 0 despite the gui/ prefix', sandbox: root, name: 'PanelRel' },
  { label: 'TRAP: prefabs/PanelRelBare.xml scores 0 too', sandbox: root, name: 'PanelRelBare' },
  // ── tie broken by localeCompare, both at rank 20 ──
  { label: 'tie broken by localeCompare (alpha before beta)', sandbox: root, name: 'TieExample' },
  { label: 'case-folded prefix', sandbox: root, name: 'mixedcase' },
  { label: 'nested recursion', sandbox: root, name: 'DeepWidget' },
  { label: 'no match -> found false', sandbox: root, name: 'NothingLikeThis' },
  { label: 'empty name -> required error', sandbox: root, name: '' },
  { label: 'whitespace name -> required error', sandbox: root, name: '   ' },
  { label: 'file with no matches', sandbox: root, name: 'Empty' },
  { label: 'stem is exactly .xml', sandbox: root, name: '.xml' },
  { label: 'second sandbox, same stem, different file (separate cache entry)', sandbox: rootB, name: 'Widget' },
  { label: 'second sandbox, again', sandbox: rootB, name: 'Widget' },
  { label: 'second sandbox, absent name', sandbox: rootB, name: 'PanelRef' },
  { label: 'first sandbox again after other tree (cache isolation)', sandbox: root, name: 'Widget' },
  { label: 'escape attempt', sandbox: root, name: '../escape' },
]

const problems = []
let expectedThrows = 0
let unexpectedThrows = 0

for (const c of CASES) {
  let baseText, liveText
  try {
    baseText = JSON.stringify(await baseFn(new PathSandbox(c.sandbox), c.name))
  } catch (error) {
    baseText = 'THREW ' + String(error?.message ?? error)
  }
  try {
    liveText = JSON.stringify(await liveFn(new PathSandbox(c.sandbox), c.name))
  } catch (error) {
    liveText = 'THREW ' + String(error?.message ?? error)
  }

  const bothThrew = baseText.startsWith('THREW ') && baseText === liveText
  if (bothThrew) {
    if (c.expectThrow) expectedThrows += 1
    else unexpectedThrows += 1
  }
  if (baseText !== liveText) {
    problems.push({ label: c.label, baseText, liveText })
  }
}

const ok = report('src/tools/read-gauntlet-ui.ts', problems, CASES.length, unexpectedThrows, expectedThrows)

// Sanity: the corpus must actually resolve a file and report extractions, and the two sandboxes
// must resolve to DIFFERENT content. Without this the case list could be passing on error
// strings alone — the exact failure the harness's throw counting exists to prevent.
let weakCorpus = false
try {
  const widget = JSON.parse(JSON.stringify(await liveFn(new PathSandbox(root), 'Widget')))
  const text = widget.content[0].text
  // The corpus feeds Widget.xml four DataSource values — 'WidgetVM' twice, a padded 'SpacedVM'
  // and an empty one — so the extraction must dedupe on the TRIMMED capture and drop the blank,
  // leaving exactly 2. A count of 4 would mean no dedupe; 3 would mean the blank survived.
  if (!text.includes('found: true') || !text.includes('data_source_count: 2')) {
    console.log('WEAK CORPUS: the Widget case did not render the expected deduped extraction counts')
    weakCorpus = true
  }
  if (!text.includes('- SpacedVM') || text.includes('-   SpacedVM')) {
    console.log('WEAK CORPUS: the padded data source was not trimmed in the rendered list')
    weakCorpus = true
  }
  const inB = JSON.parse(JSON.stringify(await liveFn(new PathSandbox(rootB), 'Widget')))
  if (!inB.content[0].text.includes('OnlyInB')) {
    console.log('WEAK CORPUS: the second sandbox did not resolve to its own file')
    weakCorpus = true
  }
  if (!weakCorpus) {
    console.log('CORPUS OK: extraction counts render, and the two sandboxes resolve independently')
  }
} catch (error) {
  console.log('WEAK CORPUS: sanity probes threw:', String(error?.message ?? error))
  weakCorpus = true
}

void GAUNTLET_ROOT
cleanupShadow()
const allOk = ok && !weakCorpus
console.log(allOk ? 'ALL EQUAL' : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
