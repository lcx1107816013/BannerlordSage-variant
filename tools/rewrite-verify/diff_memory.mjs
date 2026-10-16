// Direct baseline-vs-rewrite differential for the memory and C#-reader tools (batch 5).
//
//   project-memory-add.ts / -recent.ts / -search.ts / -wakeup.ts / -invalidate.ts
//   project-memory-capture-session.ts
//   read-csharp-type.ts
//
// NONE of these has any frozen-fixture coverage: no generator imports them. (gen_store_fixtures
// exercises src/utils/db.ts and src/utils/memory-db.ts, never the tool layer on top.) So this
// runner is their only witness.
//
// ★ THE STORES ARE REAL, NOT MOCKED. The memory database is created by the real getMemoryDb()
//   (its schema is idempotent) under a synthetic game id, and the C# reader gets a private
//   csharp_types/csharp_methods table built here. Each side runs against its OWN freshly built
//   database containing the same logical rows, so rows are produced by the real store on both
//   sides and any ordering it derives is derived identically.
//
// ★ TWO VALUES ARE INTRINSICALLY NON-REPRODUCIBLE, so they are normalised before comparison:
//     * memory ids   — `pmem_` + 12 hex of a randomUUID, written at insert time
//     * timestamps   — new Date().toISOString() at insert time
//   Both appear in the rendered report (the block header IS the memory id, and created_at /
//   updated_at are fields). Normalising them is not a weakening: the comparison is still
//   byte-exact over everything else, and id SHAPE plus timestamp FORMAT are themselves
//   asserted, because the replacement patterns only match a well-formed id and a well-formed
//   ISO timestamp. A malformed one survives into the diff and fails the comparison.
//
// Usage: bun run tools/rewrite-verify/diff_memory.mjs

import { join } from 'node:path'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { Database } from 'bun:sqlite'
import { repoRoot, cleanupShadow, report, loadBoth } from './diffharness.mjs'

const TMP = join(repoRoot, 'tools', 'rewrite-verify', '.tmp')
mkdirSync(TMP, { recursive: true })
cleanupShadow()

let allOk = true
let total = 0

const ID_PATTERN = /pmem_[0-9a-f]{12}/g
const ISO_PATTERN = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g

/**
 * Replaces the run-varying values with stable placeholders. The placeholders keep the SHAPE
 * visible (`<PMEM_ID>` is 12 hex, `<ISO_TS>` is a millisecond ISO timestamp), so a change in
 * either format still shows up as a divergence.
 */
function normalize(text) {
  return text.replaceAll(ID_PATTERN, '<PMEM_ID>').replaceAll(ISO_PATTERN, '<ISO_TS>')
}

// ═══════════════════════════════════════════════════════════════════════════
// Memory tools
// ═══════════════════════════════════════════════════════════════════════════

const MEMORY_FILES = [
  'src/tools/project-memory-add.ts',
  'src/tools/project-memory-recent.ts',
  'src/tools/project-memory-search.ts',
  'src/tools/project-memory-wakeup.ts',
  'src/tools/project-memory-invalidate.ts',
  'src/tools/project-memory-capture-session.ts',
]

/**
 * Points the store at a private game id and returns modules for one revision.
 *
 * The memory store caches its handle AND its resolved path in module scope, keyed by the
 * active game id from the environment. A cache-busting import query gives each side its own
 * module instance, and the env var is set before that import so the instance resolves to that
 * side's directory. Without both, the second side would silently reuse the first side's
 * handle — and the comparison would be of a database against itself.
 */
async function loadMemorySide(revTag) {
  const gameId = `bannerlord-fixture-mem-${revTag}`
  const dir = join(repoRoot, 'dist', 'games', gameId)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  process.env.BANNERSAGE_GAME = gameId

  const store = await import(
    pathToFileURL(join(repoRoot, 'src', 'utils', 'memory-db.ts')).href + `?side=${revTag}`
  )
  store.closeMemoryDb()

  const mods = {}
  for (const file of MEMORY_FILES) {
    const key = file.split('/').pop().replace('.ts', '')
    const { baselineMod, liveMod } = await loadBoth(file)
    mods[key] = revTag === 'base' ? baselineMod : liveMod
  }

  return { gameId, dir, store, mods }
}

// Seeded through the REAL addProjectMemory of each side, so timestamps and FTS rows come from
// real code. The blank row is one some paths reject; seeding continues either way.
const SEED = [
  { text: 'Harmony prefix patches need the __instance argument for instance methods', workspace: 'BlBridge', topic: 'harmony', kind: 'note', importance: 5 },
  { text: 'The parity fixture generator once deleted the real compiled index', workspace: 'BannerScribe', topic: 'fixtures', kind: 'pitfall', importance: 5 },
  { text: 'Prefer Map over object literal for lookup tables', workspace: 'BlBridge', topic: 'style', kind: 'preference', importance: 2 },
  { text: 'Wire the archive-go port to the registry', workspace: 'BannerScribe', topic: 'port', kind: 'todo', importance: 4 },
  { text: 'bannerscribe-regression-test is the hyphenated query shape', workspace: 'BannerScribe', topic: 'fixtures', kind: 'note', importance: 3 },
  { text: 'unicode 中文 memory row with 日本語', workspace: 'BlBridge', topic: 'i18n', kind: 'note', importance: 3 },
  { text: 'x'.repeat(300), workspace: 'long', topic: 'long', kind: 'note', importance: 1 },
]

/**
 * Builds a fresh store for one side and returns the transcript of every case.
 *
 * `fileKey` is the module key recorded by loadMemorySide (the file's basename without
 * `.ts`), NOT the exported function name; `entry` is the export to call.
 */
async function transcript(revTag, fileKey, entry, cases, call) {
  const side = await loadMemorySide(revTag)
  side.store.closeMemoryDb()

  // Seeded through THIS side's own module instance of the store, so the rows land in this
  // side's database and carry this side's timestamps.
  const { addProjectMemory } = await import(
    pathToFileURL(join(repoRoot, 'src', 'utils', 'project-memory.ts')).href + `?side=${revTag}`
  )
  for (const row of SEED) {
    try {
      addProjectMemory(row)
    } catch {
      // a rejected seed row is not a failure of the tool under test
    }
  }

  const moduleForFile = side.mods[fileKey]
  if (!moduleForFile) {
    throw new Error(`runner: no module loaded for key ${fileKey}; loaded keys: ${Object.keys(side.mods).join(', ')}`)
  }
  const fn = moduleForFile[entry]
  if (typeof fn !== 'function') {
    throw new Error(`runner: ${fileKey} has no export ${entry}; exports: ${Object.keys(moduleForFile).join(', ')}`)
  }

  const out = []
  for (const c of cases) {
    try {
      out.push(normalize(JSON.stringify(await call(fn, c))))
    } catch (error) {
      if (process.env.RV_VERBOSE) {
        console.log('   [throw]', c.label, String(error?.stack ?? error).slice(0, 400))
      }
      out.push('THREW ' + String(error?.message ?? error))
    }
  }

  side.store.closeMemoryDb()
  return out
}

async function diffMemoryFile(file, entry, cases, call) {
  const fileKey = file.split('/').pop().replace('.ts', '')
  const base = await transcript('base', fileKey, entry, cases, call)
  const live = await transcript('live', fileKey, entry, cases, call)

  if (base.length !== cases.length || live.length !== cases.length) {
    console.log(`BROKEN ${file}: transcript length mismatch (${base.length}/${live.length})`)
    allOk = false
    return
  }

  const problems = []
  let expectedThrows = 0
  let unexpectedThrows = 0
  for (let i = 0; i < cases.length; i += 1) {
    const bothThrew = base[i].startsWith('THREW ') && base[i] === live[i]
    if (bothThrew) {
      if (cases[i].expectThrow) expectedThrows += 1
      else unexpectedThrows += 1
    }
    if (base[i] !== live[i]) {
      problems.push({ label: cases[i].label, baseText: base[i], liveText: live[i] })
    }
  }

  // ★ A suite where EVERY case threw on both sides is a broken runner, not a pass. This is
  //   the exact state a missing module export produced, and it reported OK until the guard
  //   counted the throws.
  if (unexpectedThrows === cases.length && cases.length > 0) {
    console.log(`BROKEN ${file}: all ${cases.length} cases threw on both sides — the comparison is vacuous`)
    allOk = false
    return
  }

  total += cases.length
  allOk = report(file, problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

await diffMemoryFile(
  'src/tools/project-memory-add.ts',
  'projectMemoryAdd',
  [
    { label: 'plain', text: 'a durable note about harmony', workspace: 'W', topic: 't', kind: 'note', summary: 's', source: 'src', tags: ['a', 'b'], importance: 4 },
    { label: 'empty text -> refused', text: '', workspace: 'W' },
    { label: 'whitespace text -> refused', text: '   \n\t ', workspace: 'W' },
    { label: 'text trimmed before storing', text: '  padded  ', workspace: 'W' },
    { label: 'no optional args', text: 'bare minimum' },
    { label: 'importance 0', text: 'zero importance', importance: 0 },
    { label: 'importance 9', text: 'high importance', importance: 9 },
    { label: 'unicode', text: '中文 日本語 ünïcödé', workspace: 'W' },
    { label: 'hyphenated', text: 'bannerscribe-regression-test', workspace: 'W' },
    { label: 'duplicate exact row returns the existing one', text: 'Harmony prefix patches need the __instance argument for instance methods', workspace: 'BlBridge', topic: 'harmony', kind: 'note', importance: 5 },
  ],
  async (fn, c) => fn(c.text, c.workspace, c.topic, c.kind, c.summary, c.source, c.tags, c.importance)
)

await diffMemoryFile(
  'src/tools/project-memory-recent.ts',
  'projectMemoryRecent',
  [
    { label: 'no filters' },
    { label: 'workspace filter', workspace: 'BlBridge' },
    { label: 'workspace with no rows', workspace: 'NOPE' },
    { label: 'topic filter', topic: 'fixtures' },
    { label: 'kind filter', kind: 'note' },
    { label: 'limit 1', limit: 1 },
    { label: 'limit 0', limit: 0 },
    { label: 'limit huge', limit: 999 },
    { label: 'includeInactive', includeInactive: true },
    { label: 'whitespace workspace -> all scope', workspace: '   ' },
  ],
  async (fn, c) => fn(c.workspace, c.topic, c.kind, c.limit, c.includeInactive)
)

await diffMemoryFile(
  'src/tools/project-memory-search.ts',
  'projectMemorySearch',
  [
    { label: 'hit', query: 'harmony' },
    { label: 'hyphenated hit', query: 'bannerscribe-regression-test' },
    { label: 'no hit', query: 'nothingmatchesthisatall' },
    { label: 'empty query -> refused', query: '' },
    { label: 'whitespace query -> refused', query: '   ' },
    { label: 'query trimmed', query: '  harmony  ' },
    { label: 'unicode', query: '中文' },
    { label: 'with workspace', query: 'harmony', workspace: 'BlBridge' },
    { label: 'with topic', query: 'harmony', topic: 'harmony' },
    { label: 'limit 1', query: 'harmony', limit: 1 },
  ],
  async (fn, c) => fn(c.query, c.workspace, c.topic, c.kind, c.limit, c.includeInactive)
)

await diffMemoryFile(
  'src/tools/project-memory-wakeup.ts',
  'projectMemoryWakeup',
  [
    { label: 'no workspace' },
    { label: 'BlBridge', workspace: 'BlBridge' },
    { label: 'absent workspace -> empty sentence', workspace: 'NOPE' },
    { label: 'whitespace workspace', workspace: '   ' },
    { label: 'limit 1', limit: 1 },
    { label: 'limit 0', limit: 0 },
  ],
  async (fn, c) => fn(c.workspace, c.limit)
)

await diffMemoryFile(
  'src/tools/project-memory-invalidate.ts',
  'projectMemoryInvalidate',
  [
    { label: 'unknown id', memoryId: 'does-not-exist' },
    { label: 'empty id', memoryId: '' },
    { label: 'unknown id with reason', memoryId: 'nope', reason: 'superseded' },
  ],
  async (fn, c) => fn(c.memoryId, c.reason)
)

await diffMemoryFile(
  'src/tools/project-memory-capture-session.ts',
  'projectMemoryCaptureSession',
  [
    { label: 'nothing durable -> refused' },
    { label: 'summary only', summary: 'a session summary' },
    { label: 'decisions', decisions: ['d1', 'd2'], workspace: 'W', topic: 't' },
    { label: 'pitfalls', pitfalls: ['p1'], workspace: 'W' },
    { label: 'preferences', preferences: ['pref1'], workspace: 'W' },
    { label: 'todos', todos: ['t1', 't2', 't3'], workspace: 'W' },
    { label: 'notes', notes: ['n1'], workspace: 'W' },
    { label: 'all six buckets', summary: 's', decisions: ['d'], pitfalls: ['p'], preferences: ['pr'], todos: ['t'], notes: ['n'], workspace: 'W', topic: 'top', source: 'sr' },
    { label: 'empty arrays -> refused', decisions: [], pitfalls: [], todos: [], notes: [] },
    { label: 'blank strings only', decisions: ['  '], notes: [''] },
    { label: 'unicode', notes: ['中文 日本語'], workspace: 'W' },
    { label: 'whitespace workspace', notes: ['n'], workspace: '   ' },
    { label: 'sessionImportance 5', notes: ['n'], sessionImportance: 5 },
  ],
  async (fn, c) => fn(c.workspace, c.topic, c.source, c.summary, c.decisions, c.pitfalls, c.preferences, c.todos, c.notes, c.sessionImportance)
)

// ═══════════════════════════════════════════════════════════════════════════
// read-csharp-type.ts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Builds the game-source tree and index readCsharpType reads. The game id is synthetic, so
 * getGamePaths() resolves inside dist/games/<synth>/ and the real index is untouched.
 *
 * Two rows are deliberate:
 *   * Gamma — its row exists but Gamma.cs is NOT written, pinning the reader's SILENT-SKIP
 *     rule (the missing file is skipped and does not consume a header number).
 *   * Collide — the same typeName in two different files, pinning the disambiguation report.
 */
async function buildCsharpWorld(revTag) {
  const gameId = `bannerlord-fixture-csharp-${revTag}`
  const dir = join(repoRoot, 'dist', 'games', gameId)
  rmSync(dir, { recursive: true, force: true })
  const sourceDir = join(dir, 'assets', 'Source')
  mkdirSync(sourceDir, { recursive: true })
  process.env.BANNERSAGE_GAME = gameId

  writeFileSync(
    join(sourceDir, 'Alpha.cs'),
    'namespace N {\n  public class Alpha {\n    public void A() { }\n    public int B() { return 1; }\n  }\n}\n',
    'utf8'
  )
  writeFileSync(join(sourceDir, 'Beta.cs'), 'namespace N {\n  internal class Beta { }\n}\n', 'utf8')
  // Gamma.cs is deliberately absent.

  const dbPath = join(dir, `${gameId}.db`)
  const db = new Database(dbPath, { create: true })
  db.run(`CREATE TABLE csharp_types (
    typeName TEXT NOT NULL, fullName TEXT NOT NULL, filePath TEXT NOT NULL,
    startLine INTEGER, endLine INTEGER, typeKind TEXT, accessibility TEXT,
    modifiers TEXT, namespaceName TEXT, containingType TEXT
  )`)
  db.run(`CREATE TABLE csharp_methods (
    id TEXT PRIMARY KEY, typeFullName TEXT NOT NULL, memberName TEXT NOT NULL,
    memberKind TEXT, signature TEXT, returnType TEXT, filePath TEXT,
    startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER
  )`)
  db.run(`CREATE TABLE csharp_files (filePath TEXT PRIMARY KEY, fileSize INTEGER NOT NULL, fileMtimeMs REAL NOT NULL, indexedAt TEXT NOT NULL)`)

  const insType = db.prepare(
    `INSERT INTO csharp_types (typeName, fullName, filePath, startLine, endLine, typeKind, accessibility, modifiers, namespaceName, containingType) VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  insType.run('Alpha', 'N.Alpha', 'Alpha.cs', 2, 6, 'class', 'public', '', 'N', null)
  insType.run('Beta', 'N.Beta', 'Beta.cs', 2, 2, 'class', 'internal', '', 'N', null)
  // row present, file absent -> silent skip
  insType.run('Gamma', 'N.Gamma', 'Gamma.cs', 1, 3, 'class', 'public', '', 'N', null)
  // a second Gamma that DOES resolve, so one query spans one skip and one render
  insType.run('Gamma', 'N.Gamma#real', 'Alpha.cs', 1, 2, 'class', 'public', '', 'N', null)
  // colliding typeName across two files -> disambiguation
  insType.run('Collide', 'N.One.Collide', 'Alpha.cs', 1, 2, 'class', 'public', '', 'N.One', null)
  insType.run('Collide', 'N.Two.Collide', 'Beta.cs', 1, 2, 'class', 'public', '', 'N.Two', null)

  const insMethod = db.prepare(
    `INSERT INTO csharp_methods (id, typeFullName, memberName, memberKind, signature, returnType, filePath, startLine, endLine, accessibility, isStatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  insMethod.run('m1', 'N.Alpha', 'A', 'method', 'public void A()', 'void', 'Alpha.cs', 3, 3, 'public', 0)
  insMethod.run('m2', 'N.Alpha', 'B', 'method', 'public int B()', 'int', 'Alpha.cs', 4, 4, 'public', 0)
  insMethod.run('m3', 'N.Alpha', 'A', 'method', 'public void A(int x)', 'void', 'Alpha.cs', 5, 5, 'public', 0)
  db.close()

  return { gameId, dir, sourceDir, dbPath }
}

async function runCsharpSide(revTag, cases) {
  const world = await buildCsharpWorld(revTag)
  process.env.BANNERSAGE_GAME = world.gameId

  // A per-side module instance of db.ts is required: getDb() caches its handle, and the two
  // sides must not share one.
  const dbMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'db.ts')).href + `?cside=${revTag}`)
  dbMod.closeDb?.()

  const { baselineMod, liveMod } = await loadBoth('src/tools/read-csharp-type.ts')
  const fn = revTag === 'base' ? baselineMod.readCsharpType : liveMod.readCsharpType

  const out = []
  for (const c of cases) {
    try {
      out.push(JSON.stringify(await fn(c.typeName)))
    } catch (error) {
      if (process.env.RV_VERBOSE) console.log('   [throw]', c.label, String(error?.stack ?? error).slice(0, 500))
      out.push('THREW ' + String(error?.message ?? error))
    }
  }
  dbMod.closeDb?.()
  return out
}

{
  const cases = [
    { label: 'Alpha (file + 3 methods)', typeName: 'Alpha' },
    { label: 'Beta (no methods)', typeName: 'Beta' },
    { label: 'Gamma (one row skips silently)', typeName: 'Gamma' },
    { label: 'Collide (name across two files)', typeName: 'Collide' },
    { label: 'NotThere', typeName: 'NotThere' },
    { label: 'empty name', typeName: '' },
    { label: 'lowercase miss', typeName: 'alpha' },
  ]

  const base = await runCsharpSide('base', cases)
  const live = await runCsharpSide('live', cases)

  const problems = []
  let unexpectedThrows = 0
  for (let i = 0; i < cases.length; i += 1) {
    if (base[i].startsWith('THREW ') && base[i] === live[i]) unexpectedThrows += 1
    if (base[i] !== live[i]) {
      problems.push({ label: cases[i].label, baseText: base[i], liveText: live[i] })
    }
  }
  total += cases.length
  allOk = report('src/tools/read-csharp-type.ts', problems, cases.length, unexpectedThrows) && allOk
}

cleanupShadow()
console.log(allOk ? `ALL EQUAL — ${total} differential cases` : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
