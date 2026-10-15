// Parity fixture generator for src/tools/search-api-docs.ts -> tools.SearchAPIDocs.
//
// ★ HOW search_api_docs IS EXERCISED WITHOUT TOUCHING THE REFERENCE TREE OR THE REAL INDEX.
//
// The tool calls getDb('bannerlord') with the id HARD-CODED, so BANNERSAGE_GAME cannot redirect it
// and a corpus would otherwise have to be written to dist/games/bannerlord/bannerlord.db — which on
// this machine is the real 600 MB index (the write ledger F19 records as destroying it once).
//
// The way out is dependency injection at the MODULE level: `mock.module` replaces the three modules
// that supply the tool's I/O (db, env, bannerlord-setup) while every other module in its import
// chain — including bannerlord-api-docs, whose version resolution is the interesting part — stays
// REAL. So the function under test is the real searchApiDocs, not a copy, and the only thing that
// changes is where it reads from. Nothing outside tools/parity/fixtures/ is written.
//
// Usage: bun run server-go/tools/parity/gen_searchapidocs_fixtures.mjs

import { mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the fixture databases ────────────────────────────────────────────────────
const FTS_SCHEMA = `CREATE VIRTUAL TABLE bannerlord_api_entries_fts USING fts5(
  id UNINDEXED, version UNINDEXED, section UNINDEXED, searchKey, title, scope, url UNINDEXED,
  tokenize='unicode61'
)`
const BASE_SCHEMA = `CREATE TABLE bannerlord_api_entries (
  id TEXT PRIMARY KEY, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT
)`

function buildFixture(file, { versions = [], entries = [] } = {}) {
  const path = join(fixturesDir, file)
  // Refuses rather than deleting anything this harness did not mark. See fixture_guard.mjs.
  removeOwnFixtureOrRefuse(path, 'gen_searchapidocs_fixtures.mjs')
  const db = new Database(path)
  markAsFixture(db, 'gen_searchapidocs_fixtures.mjs')
  db.run(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`)
  db.run(FTS_SCHEMA)
  db.run(BASE_SCHEMA)
  for (const v of versions) db.run(`INSERT INTO bannerlord_api_versions (version) VALUES (?)`, [v])
  for (const e of entries) {
    db.run(`INSERT INTO bannerlord_api_entries (id, version, section, searchKey, title, scope, url) VALUES (?,?,?,?,?,?,?)`,
      [e.id, e.version, e.section, e.searchKey, e.title, e.scope, e.url])
    db.run(`INSERT INTO bannerlord_api_entries_fts (id, version, section, searchKey, title, scope, url) VALUES (?,?,?,?,?,?,?)`,
      [e.id, e.version, e.section, e.searchKey, e.title, e.scope, e.url])
  }
  db.close()
  return path
}

// The corpus. 'asynchronously' is the important entry: the query 'nchron' is a substring INSIDE a
// token, which FTS5's prefix matching cannot find but LIKE can — so that case exercises the
// fallback path rather than merely being meant to.
const POPULATED = [
  { id: 'a1', version: '1.2.9', section: 'classes', searchKey: 'Campaign', title: 'Campaign', scope: 'class Campaign : CampaignObjectBase', url: 'https://api/1' },
  { id: 'a2', version: '1.2.9', section: 'functions', searchKey: 'Campaign.GetTime', title: 'GetTime', scope: 'public float GetTime()', url: 'https://api/2' },
  { id: 'a3', version: '1.2.9', section: 'properties', searchKey: 'MobileParty.Position', title: 'Position', scope: '', url: 'https://api/3' },
  { id: 'a4', version: '1.2.9', section: 'classes', searchKey: 'AsyncOps', title: 'Async', scope: 'runs asynchronously', url: 'https://api/4' },
  { id: 'a5', version: '1.9.0', section: 'classes', searchKey: 'Campaign', title: 'Campaign', scope: 'class Campaign (1.9.0)', url: 'https://api/5' },
]

const populatedPath = buildFixture('searchapidocs.db', { versions: ['1.2.9', '1.9.0'], entries: POPULATED })
const emptyPath = buildFixture('searchapidocs-empty.db', { versions: [], entries: [] })
// The missing-table case: a database that has versions but NO fts table, so databaseHasTable says no.
const missingPath = join(fixturesDir, 'searchapidocs-missing.db')
removeOwnFixtureOrRefuse(missingPath, 'gen_searchapidocs_fixtures.mjs')
const missingDb = new Database(missingPath)
markAsFixture(missingDb, 'gen_searchapidocs_fixtures.mjs')
missingDb.run(`CREATE TABLE bannerlord_api_entries (id TEXT PRIMARY KEY, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT)`)
missingDb.close()

// ── module-level injection ───────────────────────────────────────────────────
const dbReal = join(repoRoot, 'src', 'utils', 'db.ts')
const envReal = join(repoRoot, 'src', 'utils', 'env.ts')
const setupReal = join(repoRoot, 'src', 'utils', 'bannerlord-setup.ts')

let ACTIVE_DB_PATH = populatedPath
let ACTIVE_STATE = {}

const handles = new Map()
function handleFor(path) {
  let h = handles.get(path)
  if (!h) {
    h = new Database(path, { readonly: true })
    handles.set(path, h)
  }
  return h
}

mock.module(dbReal, () => ({
  getDb: _gameId => handleFor(ACTIVE_DB_PATH),
  databaseHasTable: (path, tableName) => {
    try {
          const probe = new Database(path, { create: false, readonly: true })
      try {
        const row = probe.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName)
        return Boolean(row)
      } finally {
        probe.close()
      }
    } catch {
      return false
    }
  },
  closeDb: () => {},
  databaseHasColumns: () => false,
  databaseTableRowCount: () => 0,
  databaseTableRowCountWhereEquals: () => 0,
  databaseTextValue: () => null,
}))

mock.module(envReal, () => ({
  DEFAULT_GAME_ID: 'bannerlord',
  root: repoRoot,
  distPath: join(repoRoot, 'dist'),
  gamesDistPath: join(repoRoot, 'dist', 'games'),
  normalizeGameId: id => id?.trim().toLowerCase() || 'bannerlord',
  getActiveGameId: () => 'bannerlord',
  getGamePaths: gameId => ({ gameId: gameId ?? 'bannerlord', dbPath: ACTIVE_DB_PATH }),
  activeGameId: 'bannerlord',
  activeGamePaths: { dbPath: ACTIVE_DB_PATH },
  assetsPath: '', versionPath: '', defsPath: '', sourcePath: '',
  dbPath: ACTIVE_DB_PATH, memoryDbPath: '', setupStatePath: '', csharpAstDumpPath: '',
}))

mock.module(setupReal, () => ({
  loadSetupStateForGame: async _gameId => ACTIVE_STATE,
  splitCliList: () => [],
  composeFullVersion: () => '',
  getLogicalModuleName: () => '',
  normalizeVersionText: v => v,
}))

const apiMod = await import(u(join(repoRoot, 'src', 'tools', 'search-api-docs.ts')))

// ── cases ────────────────────────────────────────────────────────────────────
const CASES = [
  { label: 'installed 1.2.9 matches an indexed version -> official authority', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', limit: 10 },
  { label: 'requested 1.9.0 while installed is 1.2.9 -> local authority', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', version: '1.9.0', limit: 10 },
  { label: 'requested an unindexed version -> no selection, early report', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', version: '9.9.9', limit: 10 },
  { label: 'section filter applied', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Position', section: 'properties', limit: 10 },
  { label: 'unknown section drops the filter rather than emptying the result', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Position', section: 'bogus-section', limit: 10 },
  { label: 'LIKE fallback: a substring inside a token', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'nchron', limit: 10 },
  { label: 'no match anywhere -> empty result set, still a report', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'zzzznotpresent', limit: 10 },
  // ★ A query of "%" is the case escapeLikePattern exists for: unescaped, `%\%%` degenerates into a
  // pattern that matches EVERY row, so the report would claim five matches for a query that appears
  // in none. With escaping it matches nothing, which is the correct answer.
  { label: 'query is a bare % -> must match nothing, not everything', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: '%', limit: 10 },
  { label: 'query is a bare _ -> must match nothing', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: '_', limit: 10 },
  { label: 'query contains a % between words', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Cam%aign', limit: 10 },
  { label: 'installed unknown -> falls back to the newest indexed version', db: 'populated', state: { gameVersion: '1.5.0', fullVersion: '1.5.0.9' }, query: 'Campaign', limit: 10 },
  { label: 'installed absent entirely', db: 'populated', state: {}, query: 'Campaign', limit: 10 },
  { label: 'limit 0 clamps to the floor of 1', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', limit: 0 },
  { label: 'limit 99 clamps to the ceiling of 30', db: 'populated', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', limit: 99 },
  { label: 'empty index -> warning report, no selection', db: 'empty', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', limit: 10 },
  { label: 'no fts table -> missing-index report', db: 'missing', state: { gameVersion: '1.2.9', fullVersion: '1.2.9.1' }, query: 'Campaign', limit: 10 },
]

const out = []
for (const c of CASES) {
  ACTIVE_DB_PATH = c.db === 'populated' ? populatedPath : c.db === 'empty' ? emptyPath : missingPath
  ACTIVE_STATE = c.state
  let entry
  try {
    const res = await apiMod.searchApiDocs(c.query, c.version, c.section, c.limit)
    entry = { ...c, ok: true, text: res.content[0].text }
  } catch (error) {
    entry = { ...c, ok: false, error: String(error?.message ?? error) }
  }
  out.push(entry)
}

const fixtures = {
  _comment:
    'GENERATED by gen_searchapidocs_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/tools/search-api-docs.ts with its three I/O modules injected via mock.module, against the ' +
    'three committed databases below. Do not edit by hand.',
  dbPath: 'tools/parity/fixtures/searchapidocs.db',
  emptyDbPath: 'tools/parity/fixtures/searchapidocs-empty.db',
  missingDbPath: 'tools/parity/fixtures/searchapidocs-missing.db',
  cases: out,
}
writeFileSync(join(here, 'searchapidocs_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

const rendered = out.filter(c => c.ok)
console.log('wrote searchapidocs_fixtures.json + fixtures/searchapidocs{,-empty,-missing}.db')
console.log('  cases: ' + out.length + ' (' + rendered.length + ' rendered)')
console.log('')
const like = rendered.find(c => c.query === 'nchron')
if (like) {
  console.log('  ★ the LIKE-fallback case, first 10 lines:')
  console.log(like.text.split(NL).slice(0, 10).map(l => '      ' + l).join(NL))
} else {
  console.log('  ★ WARNING: the LIKE-fallback case did not render; the fallback corpus needs review')
}
