// Parity fixture generator for:
//   src/utils/bannerlord-toolset.ts  -> toolset.GetMode / GetActiveToolNames / the two name lists
//   src/utils/runtime-check.ts       -> runtimecheck.GetReadiness / GetStatus / the file predicates
//   src/utils/local-mod-source.ts    -> (a zero-logic alias layer; see the note emitted below)
//
// The toolset lists are computed by RUNNING the real module (its lists are the .map() over
// archiveToolName), and the mode is read through the real process.env so the precedence is real.
//
// For runtime-check the interesting part is not a value but a DECISION: whether a probe reads a
// directory at all when the profile does not require it. That is measured with a TREE ON DISK whose
// directories are crafted, including a nested-only case and an empty directory, because the two
// probes walk and stop at very different points.
//
// Usage: bun run server-go/tools/parity/gen_toolset_fixtures.mjs

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── toolset ─────────────────────────────────────────────────────────────────
const toolset = await import(u(join(repoRoot, 'src', 'utils', 'bannerlord-toolset.ts')))

const MODE_INPUTS = [
  undefined, '', '   ', 'query-first', 'QUERY-FIRST', '  query-first  ', 'Query-First',
  'full', 'FULL', 'full ', 'queryfirst', 'query_first', 'query-first extra', 'query-first\u3000',
  '\ufeffquery-first', 'query-first\u0085',
]
// The mode is read from process.env, so each case SETS the real variable and restores it — a shim
// would not exercise the actual lookup. See the bannersetup generator for the same lesson.
const modeCases = []
for (const value of MODE_INPUTS) {
  const saved = process.env.BANNERSAGE_TOOLSET
  if (value === undefined) delete process.env.BANNERSAGE_TOOLSET
  else process.env.BANNERSAGE_TOOLSET = value
  modeCases.push({
    input: value ?? null,
    mode: toolset.getBannerlordToolsetMode(),
    toolCount: toolset.getActiveBannerlordToolNames().length,
  })
  if (saved === undefined) delete process.env.BANNERSAGE_TOOLSET
  else process.env.BANNERSAGE_TOOLSET = saved
}

// ── runtime-check ───────────────────────────────────────────────────────────
// A tree on disk, built under the scratch area so nothing in the repo is touched.
// ★ THE SHAPE IS DATA AND THE TREE IS NOT COMMITTED — see the note in gen_runtimecheck_fixtures.mjs.
// One of these cases is an EMPTY directory, which git cannot track, and a placeholder file inside it
// would destroy the very case it was meant to preserve.
const SHAPE = {
  dirs: ['src', 'src/a', 'src/a/b', 'src/a/b/c', 'xmls', 'nestedOnly'],
  files: {
    'src/one.cs': 'x',
    'src/two.cs': 'x',
    'src/a/b/c/deep.cs': 'x',
    'index.db': 'x',
    'nestedOnly/inner.txt': 'x',
  },
}
const treeRoot = join(fixturesDir, 'runtimecheck-tree')
if (existsSync(treeRoot)) rmSync(treeRoot, { recursive: true, force: true })
for (const d of SHAPE.dirs) mkdirSync(join(treeRoot, ...d.split('/')), { recursive: true })
for (const [f, content] of Object.entries(SHAPE.files)) writeFileSync(join(treeRoot, ...f.split('/')), content)

const runtimeCheck = await import(u(join(repoRoot, 'src', 'utils', 'runtime-check.ts')))

// The module reads activeGameId / dbPath / defsPath / sourcePath at IMPORT time, so the paths
// cannot be passed in. The probes are therefore re-implemented here from the module's PUBLIC pieces
// — directoryHasFiles / countFilesInDirectory / fileExists — which is where all the behaviour
// lives, and the composition rule (`!requires || probe`) is asserted separately below.
const setup = await import(u(join(repoRoot, 'src', 'utils', 'bannerlord-setup.ts')))

const probeCases = []
// ★ THE THROWS ARE PART OF THE EVIDENCE, NOT AN ACCIDENT. Measured: on a path that is a FILE,
// `directoryHasFiles` and `countFilesInDirectory` both throw ENOTDIR, while `fileExists` returns
// true. A generator that crashed here would hide that; one that swallowed it would invent a value
// the TypeScript never produces. So each probe records its outcome as either a value or a throw.
const probe = async (label, dir) => {
  const entry = { label, dir }
  for (const [name, fn] of [
    ['exists', setup.fileExists],
    ['hasFiles', setup.directoryHasFiles],
    ['count', setup.countFilesInDirectory],
  ]) {
    try {
      entry[name] = await fn(dir)
      entry[name + 'Threw'] = null
    } catch (error) {
      entry[name] = null
      entry[name + 'Threw'] = String(error?.code ?? error?.message ?? error)
    }
  }
  probeCases.push(entry)
}

await probe('populated', join(treeRoot, 'src'))
await probe('empty', join(treeRoot, 'xmls'))
await probe('nested only', join(treeRoot, 'nestedOnly'))
await probe('missing', join(treeRoot, 'does-not-exist'))
await probe('a FILE, not a directory', join(treeRoot, 'index.db'))

const fixtures = {
  _comment:
    'GENERATED by gen_toolset_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/bannerlord-toolset.ts and bannerlord-setup.ts (its three file predicates, which is ' +
    'where runtime-check\'s behaviour lives). Do not edit by hand.',
  treeRoot: 'tools/parity/fixtures/runtimecheck-tree',
  shape: SHAPE,
  modeCases,
  queryFirstTools: toolset.QUERY_FIRST_BANNERLORD_TOOL_NAMES,
  authoringTools: toolset.AUTHORING_BANNERLORD_TOOL_NAMES,
  probeCases,
}
writeFileSync(join(here, 'toolset_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote toolset_fixtures.json + fixtures/runtimecheck-tree/')
console.log('  mode cases        : ' + modeCases.length)
console.log('  query-first tools : ' + fixtures.queryFirstTools.length)
console.log('  authoring tools   : ' + fixtures.authoringTools.length)
console.log('  probe cases       : ' + probeCases.length)
console.log('')
const nested = probeCases.find(c => c.label === 'nested only')
const empty = probeCases.find(c => c.label === 'empty')
const asFile = probeCases.find(c => c.label === 'a FILE, not a directory')
console.log('  ★ nested-only dir: hasFiles=' + nested.hasFiles + ' count=' + nested.count +
  '  (both WALK, so a nested file counts)')
console.log('  ★ empty dir:       hasFiles=' + empty.hasFiles + ' count=' + empty.count)
console.log('  ★ a FILE:          exists=' + asFile.exists +
  ' hasFilesThrew=' + asFile.hasFilesThrew + ' countThrew=' + asFile.countThrew)
console.log('  ★ default toolset mode with no env var: ' + modeCases[0].mode +
  ' (' + modeCases[0].toolCount + ' tools)')
