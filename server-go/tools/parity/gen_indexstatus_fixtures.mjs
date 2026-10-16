// Parity fixture generator for src/tools/bannerlord-index-status.ts -> tools.IndexStatus.
//
// The tool reads FIVE external surfaces: the setup-state JSON, the runtime revision file,
// the index database (core/docs/api tables), the XML parse report, and the live game dir
// (for the missing-DLL walk). All five are redirected onto fixture copies through
// module injection (env, setup, runtime-revision, db, game-profiles), keeping the tool
// itself REAL.
//
// ★ THE GAME-DIR WALK NEEDS A REAL TREE. getMissingOfficialDlls classifies modules and
// walks every dll under the install. The corpus below builds a miniature install with:
//   - an official module (Native) with a bin dll that IS indexed (not missing)
//   - an official module (SandBox) with a bin dll that is NOT indexed (missing!)
//   - a community module with a bin dll (never a candidate: not official)
//   - a root-bin official dll that is indexed
//   - a root-bin official dll that is NOT indexed (missing!)
//
// The setup state's dllScope is 'official' so the check runs.
//
// Usage: bun run server-go/tools/parity/gen_indexstatus_fixtures.mjs

import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the miniature install ────────────────────────────────────────────────────
const gameDir = join(fixturesDir, 'indexstatus-game')
if (existsSync(gameDir)) rmSync(gameDir, { recursive: true, force: true })
const wf = (rel, body) => {
  const full = join(gameDir, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, body, 'utf8')
}
wf('Modules/Native/SubModule.xml', `<Module>\n  <Id value="Native"/>\n  <Name value="Native"/>\n  <ModuleType value="Official"/>\n</Module>\n`)
wf('Modules/Native/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.View.dll', 'native-view-dll')
wf('Modules/SandBox/SubModule.xml', `<Module>\n  <Id value="SandBox"/>\n  <Name value="Sandbox"/>\n  <ModuleType value="Official"/>\n</Module>\n`)
wf('Modules/SandBox/bin/Win64_Shipping_Client/SandBox.dll', 'sandbox-dll')
wf('Modules/CommunityMod/SubModule.xml', `<Module>\n  <Id value="CommunityMod"/>\n  <Name value="Community Mod"/>\n</Module>\n`)
wf('Modules/CommunityMod/bin/Win64_Shipping_Client/CommunityMod.dll', 'community-dll')
wf('bin/Win64_Shipping_Client/TaleWorlds.CampaignSystem.dll', 'campaign-dll')
wf('bin/Win64_Shipping_Client/TaleWorlds.Engine.dll', 'engine-dll-not-indexed')

// ── the fixture state + paths ────────────────────────────────────────────────
const stateDir = join(fixturesDir, 'indexstatus-state')
if (existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true })
mkdirSync(stateDir, { recursive: true })
const dbPath = join(stateDir, 'index.db')
const versionPath = join(stateDir, 'Version.txt')
const setupStatePath = join(stateDir, 'setup-state.json')
const parseReportPath = join(stateDir, 'xml-parse-report.json')

writeFileSync(versionPath, '2026-10-16T00:00:00.000Z' + NL, 'utf8')
writeFileSync(setupStatePath, JSON.stringify({
  version: 2,
  gameDir,
  gameVersion: 'v1.2.9',
  buildChangeset: 'changeset-abc',
  fullVersion: '1.2.9.1',
  versionSource: 'steam',
  dllScope: 'official',
  xmlScope: 'core',
  dlls: {
    'modules/native/bin/win64_shipping_client/taleworlds.mountandblade.view.dll': { md5: 'x1', sourceFile: 'a', outputDir: 'b', updatedAt: 't' },
    'bin/win64_shipping_client/taleworlds.campaignsystem.dll': { md5: 'x2', sourceFile: 'a', outputDir: 'b', updatedAt: 't' },
  },
  xmlFiles: { 'a.xml': { sourceFile: 'a', size: 1, mtimeMs: 1.0, updatedAt: 't' } },
}, null, 2), 'utf8')
writeFileSync(parseReportPath, JSON.stringify({ parseFailureCount: 2 }), 'utf8')

// ── the index database ───────────────────────────────────────────────────────
removeOwnFixtureOrRefuse(dbPath, 'gen_indexstatus_fixtures.mjs')
const db = new Database(dbPath)
markAsFixture(db, 'gen_indexstatus_fixtures.mjs')
db.run(`CREATE TABLE csharp_types (id INTEGER)`)
db.run(`INSERT INTO csharp_types VALUES (1),(2),(3)`)
db.run(`CREATE TABLE csharp_methods (id INTEGER)`)
db.run(`INSERT INTO csharp_methods VALUES (1)`)
db.run(`CREATE TABLE source_localization_entries (id INTEGER)`)
db.run(`CREATE TABLE xml_entities (id INTEGER)`)
db.run(`CREATE TABLE localization_entries (id INTEGER)`)
db.run(`INSERT INTO localization_entries VALUES (1),(2)`)
db.run(`CREATE TABLE bannerlord_items (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_troops (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_heroes (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_clans (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_kingdoms (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_settlements (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_cultures (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_skills (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_policies (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_perks (id INTEGER)`)
db.run(`CREATE TABLE bannerlord_docs_pages (id INTEGER, source TEXT)`)
db.run(`INSERT INTO bannerlord_docs_pages VALUES (1,'official_moddocs'),(2,'official_moddocs'),(3,'community_modding_docs')`)
db.run(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`)
db.run(`INSERT INTO bannerlord_api_versions VALUES ('1.2.9')`)
db.run(`CREATE TABLE bannerlord_api_entries (id TEXT, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT)`)
db.run(`INSERT INTO bannerlord_api_entries VALUES ('a1','1.2.9','classes','Hero','Hero','class Hero','https://api/1')`)
db.close()

// ── module injection ─────────────────────────────────────────────────────────
const dbReal = join(repoRoot, 'src', 'utils', 'db.ts')
const envReal = join(repoRoot, 'src', 'utils', 'env.ts')
const setupReal = join(repoRoot, 'src', 'utils', 'bannerlord-setup.ts')
const revReal = join(repoRoot, 'src', 'utils', 'runtime-revision.ts')

mock.module(dbReal, () => ({
  getDb: () => new Database(dbPath, { readonly: true }),
  databaseHasTable: (path, tableName) => {
    try {
      const probe = new Database(path, { create: false, readonly: true })
      try {
        return Boolean(probe.query(`SELECT name FROM sqlite_master WHERE type IN ('table','virtual') AND name = ?`).get(tableName))
      } finally { probe.close() }
    } catch { return false }
  },
  closeDb: () => {},
  databaseHasColumns: () => false,
  databaseTableRowCount: () => 0,
  databaseTableRowCountWhereEquals: () => 0,
  databaseTextValue: () => null,
}))

const gamePaths = {
  gameId: 'bannerlord', root: repoRoot, gameDistPath: stateDir, assetsPath: join(stateDir, 'assets'),
  reportsPath: stateDir, versionPath, defsPath: join(stateDir, 'Xmls'), sourcePath: join(stateDir, 'Source'),
  dbPath, memoryDbPath: join(stateDir, 'memory.db'), setupStatePath,
  csharpAstDumpPath: join(stateDir, 'csharp-index.json'),
  xmlParseReportPath: parseReportPath, xmlParseReportMarkdownPath: join(stateDir, 'xml-parse-report.md'),
}
mock.module(envReal, () => ({
  DEFAULT_GAME_ID: 'bannerlord',
  root: repoRoot,
  distPath: join(repoRoot, 'dist'),
  gamesDistPath: join(repoRoot, 'dist', 'games'),
  normalizeGameId: id => id?.trim().toLowerCase() || 'bannerlord',
  getActiveGameId: () => 'bannerlord',
  getGamePaths: () => gamePaths,
  activeGameId: 'bannerlord',
  activeGamePaths: gamePaths,
  assetsPath: gamePaths.assetsPath, versionPath, defsPath: gamePaths.defsPath, sourcePath: gamePaths.sourcePath,
  dbPath, memoryDbPath: gamePaths.memoryDbPath, setupStatePath, csharpAstDumpPath: gamePaths.csharpAstDumpPath,
}))

mock.module(setupReal, () => ({
  loadSetupStateForGame: async () => JSON.parse(await (await import('node:fs/promises')).readFile(setupStatePath, 'utf8')),
  splitCliList: () => [],
  composeFullVersion: () => '',
  getLogicalModuleName: () => '',
}))

mock.module(revReal, () => ({
  ensureRuntimeRevisionFresh: () => false,
  readRuntimeRevision: () => '2026-10-16T00:00:00.000Z',
  writeRuntimeRevision: async () => {},
  ensureRevisionFresh: () => false,
  readRevisionFile: () => '2026-10-16T00:00:00.000Z',
  writeRevisionFile: async () => {},
  registerRuntimeInvalidator: () => () => {},
}))

// ── run the real TypeScript ──────────────────────────────────────────────────
const mod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'bannerlord-index-status.ts')).href)
const { bannerlordIndexStatus } = mod

const CASES = [
  { label: 'full state: all four blocks, missing DLLs visible', gameId: 'bannerlord' },
  { label: 'another game id normalizes to the same paths', gameId: 'BANNERLORD' },
]

const out = []
for (const c of CASES) {
  let entry
  try {
    const res = await bannerlordIndexStatus(c.gameId)
    entry = { ...c, ok: true, text: res.content[0].text }
  } catch (error) {
    entry = { ...c, ok: false, error: String(error?.message ?? error) }
  }
  out.push(entry)
}

// ── record, with the game-dir path stripped ──────────────────────────────────
const stripGame = value => typeof value === 'string' ? value.split(gameDir).join('<GAME>') : value
const stripped = out.map(c => ({ ...c, text: stripGame(c.text) }))

const fixtures = {
  _comment:
    'GENERATED by gen_indexstatus_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/tools/bannerlord-index-status.ts with env/setup/db/runtime-revision injected via ' +
    'mock.module, against the miniature install in fixtures/indexstatus-game, the state+db in ' +
    'fixtures/indexstatus-state. The game dir is stripped to <GAME>. Do not edit by hand.',
  gameTree: {
    'Modules/Native/SubModule.xml': '<Module><Id value="Native"/><Name value="Native"/><ModuleType value="Official"/></Module>',
    'Modules/Native/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.View.dll': 'native-view-dll',
    'Modules/SandBox/SubModule.xml': '<Module><Id value="SandBox"/><Name value="Sandbox"/><ModuleType value="Official"/></Module>',
    'Modules/SandBox/bin/Win64_Shipping_Client/SandBox.dll': 'sandbox-dll',
    'Modules/CommunityMod/SubModule.xml': '<Module><Id value="CommunityMod"/><Name value="Community Mod"/></Module>',
    'Modules/CommunityMod/bin/Win64_Shipping_Client/CommunityMod.dll': 'community-dll',
    'bin/Win64_Shipping_Client/TaleWorlds.CampaignSystem.dll': 'campaign-dll',
    'bin/Win64_Shipping_Client/TaleWorlds.Engine.dll': 'engine-dll-not-indexed',
  },
  state: {
    gameVersion: 'v1.2.9',
    buildChangeset: 'changeset-abc',
    fullVersion: '1.2.9.1',
    versionSource: 'steam',
    dllScope: 'official',
    xmlScope: 'core',
    dlls: {
      'modules/native/bin/win64_shipping_client/taleworlds.mountandblade.view.dll': 'indexed',
      'bin/win64_shipping_client/taleworlds.campaignsystem.dll': 'indexed',
    },
    xmlFiles: { 'a.xml': 1 },
    runtimeRevision: '2026-10-16T00:00:00.000Z',
    parseFailureCount: 2,
  },
  cases: stripped,
}
writeFileSync(join(here, 'indexstatus_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote indexstatus_fixtures.json + fixtures/indexstatus-state/index.db')
console.log('  cases: ' + out.length + ' (' + out.filter(c => c.ok).length + ' rendered)')
const full = out.find(c => c.ok)
if (full) {
  const missing = full.text.split(NL).filter(l => l.startsWith('- SandBox') || l.startsWith('- TaleWorlds.Engine') || l.startsWith('- TaleWorlds.Mount'))
  console.log('  ★ missing_official_dlls lines:')
  for (const l of missing.slice(0, 6)) console.log('      ' + l)
}
