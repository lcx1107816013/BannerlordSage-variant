// Parity fixture generator for src/tools/search-knowledge.ts -> tools.SearchKnowledge.
//
// The tool orchestrates three sub-searches (searchDocs / searchApiDocs / searchSource)
// whose Go ports exist and have their own parity suites; what THIS harness pins is the
// orchestration: intent routing, the query builders, safeSearch degradation, the block
// assembly and the 80-line nested truncation.
//
// The three I/O surfaces are injected at the module level so the TS under test stays
// real while its sub-calls land on a crafted corpus:
//   * db.ts getDb -> a fixture database with a docs FTS table and an api FTS table
//   * env.ts getGamePaths + bannerlord-setup.ts loadSetupStateForGame -> fixed paths/state
//   * search-source.ts searchSource -> a ripgrep run over a committed corpus dir
//
// The source-search corpus is SMALL (< 120 matches per query) because searchSource is
// nondeterministic above that limit (ledger F22); every query below matches a handful.
//
// ★ THE INTENT CASES ARE THE POINT. The routing is pure logic with sharp edges:
//   - a call-shape query (Hero( -> api
//   - an English keyword query (harmony patch -> make_mod via the LOWERED regex)
//   - a Chinese query (做一个 mod -> make_mod via the RAW regex)
//   - an explicit intent overriding auto (docs skips api+source)
//   - a symbol-bearing query (extractLikelySymbol wins over every keyword mapping,
//     and 'Bannerlord' is blacklisted while 'bannerlord' is not)
//   - a query whose docs queries get REMAPPED (ui -> Gauntlet UI / SubModule etc.)
//
// Usage: bun run server-go/tools/parity/gen_searchknowledge_fixtures.mjs

import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the docs+api database ─────────────────────────────────────────────────────
const dbPath = join(fixturesDir, 'searchknowledge.db')
removeOwnFixtureOrRefuse(dbPath, 'gen_searchknowledge_fixtures.mjs')
const db = new Database(dbPath)
db.run(`CREATE TABLE bannerlord_docs (
  id TEXT PRIMARY KEY, source TEXT, language TEXT, category TEXT, title TEXT, url TEXT, body TEXT
)`)
db.run(`CREATE VIRTUAL TABLE bannerlord_docs_fts USING fts5(
  id UNINDEXED, source UNINDEXED, language UNINDEXED, category UNINDEXED, title, url UNINDEXED, body,
  content='bannerlord_docs', content_rowid='rowid', tokenize='unicode61'
)`)
const insertDoc = db.prepare(`INSERT INTO bannerlord_docs (id, source, language, category, title, url, body) VALUES (?,?,?,?,?,?,?)`)
insertDoc.run('k1', 'own_knowledge', 'en', 'guide', 'Gauntlet UI basics', 'https://x/1', 'How to bind a gauntlet widget to a view model. gauntletui_marker.')
insertDoc.run('k2', 'official_moddocs', 'en', 'reference', 'CampaignSystem events', 'https://x/2', 'Event hooking for campaign behaviour. gauntletui_marker.')
insertDoc.run('k3', 'community_modding_docs', 'en', 'tutorial', 'Harmony patching', 'https://x/3', 'Prefix and postfix patches explained. harmony_marker.')
insertDoc.run('k4', 'own_knowledge', 'en', 'guide', 'SubModule anatomy', 'https://x/4', 'A module needs a SubModule xml. submodule_marker.')
markAsFixture(db, 'gen_searchknowledge_fixtures.mjs')
db.run(`INSERT INTO bannerlord_docs_fts(bannerlord_docs_fts) VALUES('rebuild')`)

// The api entries + versions tables, shaped like the real index.
db.run(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`)
db.run(`CREATE TABLE bannerlord_api_entries (
  id TEXT, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT
)`)
db.run(`CREATE VIRTUAL TABLE bannerlord_api_entries_fts USING fts5(
  searchKey, title, scope, version UNINDEXED, section UNINDEXED, url UNINDEXED, id UNINDEXED,
  content='bannerlord_api_entries', content_rowid='rowid', tokenize='unicode61'
)`)
db.run(`INSERT INTO bannerlord_api_versions VALUES ('1.2.9')`)
const insertApi = db.prepare(`INSERT INTO bannerlord_api_entries (id, version, section, searchKey, title, scope, url) VALUES (?,?,?,?,?,?,?)`)
insertApi.run('a1', '1.2.9', 'classes', 'Hero', 'Hero', 'class Hero', 'https://api/1')
insertApi.run('a2', '1.2.9', 'properties', 'MobileParty.Position', 'Position', 'public Vec3 Position', 'https://api/2')
insertApi.run('a3', '1.2.9', 'classes', 'CampaignBehavior', 'CampaignBehavior', 'interface CampaignBehavior', 'https://api/3')
markAsFixture(db, 'gen_searchknowledge_fixtures.mjs')
db.run(`INSERT INTO bannerlord_api_entries_fts(bannerlord_api_entries_fts) VALUES('rebuild')`)
db.close()

// ── the source corpus ────────────────────────────────────────────────────────
const corpusDir = join(fixturesDir, 'searchknowledge-corpus')
mkdirSync(join(corpusDir, 'src'), { recursive: true })
const wf = (rel, body) => writeFileSync(join(corpusDir, rel), body, 'utf8')
wf('src/Hero.cs', 'public class Hero {\n  // hero_marker one\n  public void Act() { }\n}\n')
wf('src/MobileParty.cs', 'public class MobileParty {\n  // heromarker two\n  public void Move() { }\n}\n')
wf('src/CampaignBehavior.cs', 'public interface CampaignBehavior {\n  // campaignbehavior_marker\n}\n')

// ── module injection ─────────────────────────────────────────────────────────
const dbReal = join(repoRoot, 'src', 'utils', 'db.ts')
const envReal = join(repoRoot, 'src', 'utils', 'env.ts')
const setupReal = join(repoRoot, 'src', 'utils', 'bannerlord-setup.ts')

const handles = new Map()
const handleFor = path => {
  if (!handles.has(path)) handles.set(path, new Database(path, { readonly: true }))
  return handles.get(path)
}

mock.module(dbReal, () => ({
  getDb: () => handleFor(dbPath),
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
  getGamePaths: gameId => ({ gameId: gameId ?? 'bannerlord', dbPath }),
  activeGameId: 'bannerlord',
  activeGamePaths: { dbPath },
  assetsPath: '', versionPath: '', defsPath: '', sourcePath: '',
  dbPath, memoryDbPath: '', setupStatePath: '', csharpAstDumpPath: '',
}))

mock.module(setupReal, () => ({
  loadSetupStateForGame: async () => ({ version: 2, gameDir: 'D:/FixtureGame', gameVersion: '1.2.9', buildChangeset: 'abc', fullVersion: '1.2.9.1', versionSource: 'fixture', dllScope: 'official', xmlScope: 'core', dlls: {}, xmlFiles: {} }),
  splitCliList: () => [],
  composeFullVersion: () => '',
  getLogicalModuleName: () => '',
}))

const sandboxMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'path-sandbox.ts')).href)
const { PathSandbox } = sandboxMod
const knowledgeMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'search-knowledge.ts')).href)
const { searchKnowledge } = knowledgeMod

// The sandbox is rooted at the corpus dir, so searchSource's rg runs there.
const box = new PathSandbox(corpusDir)

const CASES = [
  // intent routing: call-shape -> api
  { label: 'call-shape query routes to api (docs skipped)', query: 'Hero(', intent: undefined },
  // english keyword -> make_mod via the LOWERED regex
  { label: 'harmony keyword -> make_mod, all three surfaces', query: 'how to harmony patch a method', intent: undefined },
  // chinese -> make_mod via the RAW regex
  { label: 'chinese make-mod phrasing', query: '我要做一个招募俘虏的 mod', intent: undefined },
  // explicit intents
  { label: 'explicit docs intent skips api and source', query: 'gauntlet', intent: 'docs' },
  { label: 'explicit api intent skips docs', query: 'Hero', intent: 'api' },
  { label: 'explicit source intent skips docs and api', query: 'hero_marker', intent: 'source' },
  // symbol extraction wins over keyword mapping; blacklist is case-sensitive
  { label: 'dotted symbol wins and is used for api+source', query: 'help with MobileParty.Position binding', intent: undefined },
  { label: 'blacklisted Bannerlord falls through to keyword mapping', query: 'Bannerlord ui question', intent: undefined },
  // ★ THREE EQUAL-LENGTH SYMBOLS. The TS sort is STABLE and only compares lengths, so the
  // FIRST match in query order wins. sort.Slice on TWO elements never swaps a tie (Go's
  // insertion sort keeps adjacent order when less is false), so a 2-symbol tie cannot
  // observe stability — a sort.Slice mutation SURVIVED a 2-symbol corpus (measured, cache
  // cleared). Three symbols is the smallest shape where Go's unstable pdqsort MAY reorder.
  // 'Hero'/'Band'/'Mage' are all 4 chars; stability picks Hero (the first match).
  { label: 'equal-length symbols keep match order (stable sort)', query: 'Hero runs with Band near Mage', intent: undefined },
  // docs query remapping
  { label: 'ui query remaps docs queries to Gauntlet UI', query: 'ui', intent: undefined },
  { label: 'xml query remaps community docs to SubModule XML', query: 'xml data editing', intent: undefined },
  // the own-docs source filter path
  { label: 'plain english query searches own docs', query: 'submodule anatomy', intent: undefined },
  // limits: the clamp
  { label: 'limit 99 clamps to 10', query: 'gauntlet', intent: undefined, limit: 99 },
  { label: 'limit 0 clamps to 1', query: 'gauntlet', intent: undefined, limit: 0 },
]

const out = []
for (const c of CASES) {
  let entry
  try {
    const res = await searchKnowledge(box, c.query, c.intent, c.limit ?? 5)
    entry = { ...c, ok: true, text: res.content[0].text }
  } catch (error) {
    entry = { ...c, ok: false, error: String(error?.message ?? error) }
  }
  out.push(entry)
}

const fixtures = {
  _comment:
    'GENERATED by gen_searchknowledge_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/tools/search-knowledge.ts with db/env/setup injected via mock.module and searchSource running ' +
    'the real ripgrep over fixtures/searchknowledge-corpus. Do not edit by hand.',
  dbPath: 'tools/parity/fixtures/searchknowledge.db',
  corpusFiles: ['src/Hero.cs', 'src/MobileParty.cs', 'src/CampaignBehavior.cs'],
  cases: out,
}
writeFileSync(join(here, 'searchknowledge_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

const rendered = out.filter(c => c.ok)
console.log('wrote searchknowledge_fixtures.json + fixtures/searchknowledge.db')
console.log('  cases: ' + out.length + ' (' + rendered.length + ' rendered)')
