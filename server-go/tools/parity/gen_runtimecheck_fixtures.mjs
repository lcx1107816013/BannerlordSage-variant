// Parity fixture generator for the runtime-check PROBES (not just its predicates):
//   getInitializationReadiness / getInitializationStatus
//
// ★ WHY INJECTION IS NEEDED HERE. Both probes read `activeGameId`, `dbPath`, `defsPath` and
// `sourcePath` from module-level constants in env.ts — they take no arguments. Without replacing
// that module the expectations would be computed against the REAL dist/games/bannerlord tree, which
// exists on this machine and not on a fresh clone (the harness README's "passes here, fails there"
// failure). env and game-profiles are therefore replaced; bannerlord-setup's three predicates stay
// REAL, because they are part of what the probe's behaviour consists of.
//
// The interesting case is not a value but a DECISION: whether a probe reads a directory at all when
// the profile does not require it. The tree is crafted so that a wrong decision is visible.
//
// Usage: bun run server-go/tools/parity/gen_runtimecheck_fixtures.mjs

import { mock } from 'bun:test'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the tree ────────────────────────────────────────────────────────────────
//
// ★ THE SHAPE IS DATA, AND IT IS WRITTEN BEFORE THE TREE IS BUILT. The tree itself is NOT committed:
// git cannot track an empty directory, and an EMPTY directory is exactly what one of these cases is
// about. Committing it would have needed a placeholder file, which would have destroyed the case it
// was meant to preserve. Instead the shape is emitted below as a list, the Go side rebuilds from it,
// and both sides therefore describe the same tree by construction. The expectations are still
// produced by EXECUTING the real TypeScript against the tree.
const SHAPE = {
  dirs: ['source', 'source/nested', 'xmls'],
  files: {
    'source/a.cs': 'x',
    'source/b.cs': 'x',
    'source/nested/c.cs': 'x',
    'index.db': 'x',
  },
}
const tree = join(fixturesDir, 'runtimecheck-probe-tree')
if (existsSync(tree)) rmSync(tree, { recursive: true, force: true })
for (const d of SHAPE.dirs) mkdirSync(join(tree, ...d.split('/')), { recursive: true })
for (const [f, content] of Object.entries(SHAPE.files)) writeFileSync(join(tree, ...f.split('/')), content)

const SOURCE = join(tree, 'source')
const XMLS = join(tree, 'xmls')          // empty on purpose
const DB = join(tree, 'index.db')        // a FILE
const MISSING = join(tree, 'absent')     // never created

// ── injection ───────────────────────────────────────────────────────────────
const envReal = join(repoRoot, 'src', 'utils', 'env.ts')
const profilesReal = join(repoRoot, 'src', 'utils', 'game-profiles.ts')

let ACTIVE = { gameId: 'bannerlord', dbPath: DB, defsPath: XMLS, sourcePath: SOURCE }
let REQUIRES = { requiresSource: true, requiresXml: true, requiresDb: true }

mock.module(envReal, () => ({
  DEFAULT_GAME_ID: 'bannerlord',
  root: repoRoot,
  distPath: join(repoRoot, 'dist'),
  gamesDistPath: join(repoRoot, 'dist', 'games'),
  normalizeGameId: id => id?.trim().toLowerCase() || 'bannerlord',
  getActiveGameId: () => ACTIVE.gameId,
  getGamePaths: () => ({ gameId: ACTIVE.gameId, dbPath: ACTIVE.dbPath }),
  activeGameId: ACTIVE.gameId,
  activeGamePaths: { gameId: ACTIVE.gameId, dbPath: ACTIVE.dbPath },
  // The four the probes read
  assetsPath: '', versionPath: '', defsPath: ACTIVE.defsPath, sourcePath: ACTIVE.sourcePath,
  dbPath: ACTIVE.dbPath, memoryDbPath: '', setupStatePath: '', csharpAstDumpPath: '',
}))

mock.module(profilesReal, () => ({
  getGameProfile: () => ({ id: 'bannerlord', ...REQUIRES }),
  listGameProfiles: () => [{ id: 'bannerlord', ...REQUIRES }],
}))

const mod = await import(u(join(repoRoot, 'src', 'utils', 'runtime-check.ts')))

// ── cases ───────────────────────────────────────────────────────────────────
// The paths are read at IMPORT time by the probes (`import { activeGameId, dbPath, ... }`), so the
// values above are what the probes see; the cases vary the PROFILE instead, which is read per call.
const CASES = [
  // NOTE: the xml directory in this tree is EMPTY on purpose, so "all three required" is NOT ready.
  // The label says so rather than claiming "everything present", which would be false.
  { label: 'all three required (xml dir is EMPTY)', requires: { requiresSource: true, requiresXml: true, requiresDb: true } },
  { label: 'nothing required at all', requires: { requiresSource: false, requiresXml: false, requiresDb: false } },
  { label: 'only db required (present)', requires: { requiresSource: false, requiresXml: false, requiresDb: true } },
  { label: 'only xml required (empty dir)', requires: { requiresSource: false, requiresXml: true, requiresDb: false } },
  { label: 'only source required (present)', requires: { requiresSource: true, requiresXml: false, requiresDb: false } },
]

const readinessCases = []
const statusCases = []
for (const c of CASES) {
  REQUIRES = c.requires
  readinessCases.push({ ...c, result: await mod.getInitializationReadiness() })
  statusCases.push({ ...c, result: await mod.getInitializationStatus() })
}

// ── the missing-db case, which needs the constant to point elsewhere ────────
// The probes' paths are module constants, so a second import of the module is the only way to reach
// a different dbPath in the same process. That is exactly why the flag below is recorded: the GO
// side takes paths as arguments, so it can vary them freely and the difference is stated rather
// than simulated.
ACTIVE = { ...ACTIVE, dbPath: MISSING }
const mod2 = await import(u(join(repoRoot, 'src', 'utils', 'runtime-check.ts')) + '?second=1')
const second = []
for (const c of [
  { label: 'db required, db ABSENT', requires: { requiresSource: false, requiresXml: false, requiresDb: true } },
  { label: 'db NOT required, db absent', requires: { requiresSource: false, requiresXml: false, requiresDb: false } },
]) {
  REQUIRES = c.requires
  second.push({ ...c, result: await mod2.getInitializationReadiness() })
}

const fixtures = {
  _comment:
    'GENERATED by gen_runtimecheck_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/runtime-check.ts with env.ts and game-profiles.ts injected, so the probes read ' +
    'fixtures/runtimecheck-probe-tree instead of the machine\'s real dist tree. Do not edit by hand. ' +
    'The Go test rebuilds the tree from `shape` rather than using a committed one: git cannot track ' +
    'the EMPTY directory one case depends on, and a placeholder file inside it would destroy that ' +
    'very case.',
  tree: 'tools/parity/fixtures/runtimecheck-probe-tree',
  shape: SHAPE,
  sourcePath: 'tools/parity/fixtures/runtimecheck-probe-tree/source',
  xmlsPath: 'tools/parity/fixtures/runtimecheck-probe-tree/xmls',
  dbPath: 'tools/parity/fixtures/runtimecheck-probe-tree/index.db',
  missingPath: 'tools/parity/fixtures/runtimecheck-probe-tree/absent',
  readinessCases,
  statusCases,
  missingDbCases: second,
}
writeFileSync(join(here, 'runtimecheck_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote runtimecheck_fixtures.json + fixtures/runtimecheck-probe-tree/')
console.log('  readiness cases : ' + readinessCases.length)
console.log('  status cases    : ' + statusCases.length)
console.log('')
for (const c of readinessCases) {
  console.log('  ' + c.label.padEnd(42) + ' ready=' + String(c.result.ready).padEnd(6) +
    ' dbExists=' + c.result.dbExists)
}
const st = statusCases.find(c => c.result.sourceFiles > 0)
console.log('')
console.log('  ★ status counts even when the profile does not require the artifact:')
console.log('      ' + JSON.stringify(st.result))
