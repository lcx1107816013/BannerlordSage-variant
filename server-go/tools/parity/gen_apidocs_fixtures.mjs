// Parity fixture generator for src/utils/bannerlord-api-docs.ts
//   normalizeApiVersion / compareApiVersions / readIndexedApiVersions / resolveBannerlordApiVersion
//
// The pure functions are module-public, so they are imported and executed directly. readIndexed
// ApiVersions and resolveBannerlordApiVersion take a db handle, so this builds a small fixture
// database (committed, alongside the other parity databases) containing bannerlord_api_versions and
// exercises the resolution branches against it.
//
// Usage: bun run server-go/tools/parity/gen_apidocs_fixtures.mjs

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)

const mod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'bannerlord-api-docs.ts')).href)

// ── the fixture database ─────────────────────────────────────────────────────
// It lives under tools/parity/fixtures/ so it is committed, and it holds ONLY synthetic rows.
const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })
const dbPath = join(fixturesDir, 'apidocs.db')
// Refuses rather than deleting anything this harness did not mark. See fixture_guard.mjs.
removeOwnFixtureOrRefuse(dbPath, 'gen_apidocs_fixtures.mjs')

const db = new Database(dbPath)
db.run(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`)
db.run(`CREATE TABLE bannerlord_api_entries (id TEXT PRIMARY KEY, version TEXT, section TEXT, searchKey TEXT, title TEXT, scope TEXT, url TEXT)`)

// Versions chosen so the NUMERIC sort and a TEXTUAL sort disagree: as text, "1.10.0" < "1.9.0".
const versions = ['1.2.9', '1.9.0', '1.10.0', '2.0.0']
for (const v of versions) db.run(`INSERT INTO bannerlord_api_versions (version) VALUES (?)`, [v])
markAsFixture(db, 'gen_apidocs_fixtures.mjs')

// ── pure-function corpora ────────────────────────────────────────────────────
const normalizeCases = [
  undefined, null, '', '   ', 'v1.2.9', 'V1.2.9', 'vV1.2.9', 'vv1.2.9', 'vvv1',
  '1.2.9', '1.2', '1', '1.2.9.4.5', '1..2', '.1.2.3', '1.2.9.', 'a.b.c', '1.2.9rc1',
  ' v1.2 ', '\tv1.2.9\t', 'v', 'V', 'v.1.2', '1.2.9.x.y',
].map(v => ({ value: v ?? null, result: mod.normalizeApiVersion(v ?? undefined) ?? null }))

const compareCases = [
  ['1.2.9', '1.2.9'], ['1.2.9', '1.10.0'], ['1.10.0', '1.9.0'], ['2.0.0', '1.99.99'],
  ['1.2', '1.2.0'], ['1.2.0', '1.2'], ['1', '1.0.0'], ['1.0.0', '1'],
  ['1a', '1'], ['9x9', '9'], ['1e3', '1'], ['0x10', '16'],
  ['abc', '0'], ['', ''], ['v1.2.9', '1.2.9'], ['1.2.9', '1.2.9.1'],
  ['-1', '1'], ['+2', '2'], ['1.2.9', '1.2.9.0'],
].map(([l, r]) => ({ left: l, right: r, result: mod.compareApiVersions(l, r) }))

// ── resolution branches against the fixture database ─────────────────────────
const states = [
  { label: 'nothing indexed yet', gameVersion: undefined, fullVersion: undefined, requested: undefined },
  { label: 'installed matches an indexed version', gameVersion: '1.2.9', fullVersion: '1.2.9.123', requested: undefined },
  { label: 'installed is absent', gameVersion: undefined, fullVersion: undefined, requested: undefined },
  { label: 'installed not in the index -> newest', gameVersion: '1.5.0', fullVersion: '1.5.0.9', requested: undefined },
  { label: 'gameVersion absent, fullVersion present', gameVersion: undefined, fullVersion: '1.9.0.7', requested: undefined },
  { label: 'gameVersion present but unparseable', gameVersion: 'abc', fullVersion: '1.2.9.5', requested: undefined },
  { label: 'requested exactly an indexed one', gameVersion: '1.2.9', fullVersion: '1.2.9.1', requested: '1.10.0' },
  { label: 'requested matches the installed one', gameVersion: '1.2.9', fullVersion: '1.2.9.1', requested: '1.2.9' },
  { label: 'requested is not indexed', gameVersion: '1.2.9', fullVersion: '1.2.9.1', requested: '9.9.9' },
  { label: 'requested with a v prefix', gameVersion: '1.2.9', fullVersion: '1.2.9.1', requested: 'v1.10.0' },
  { label: 'requested is empty string', gameVersion: '1.2.9', fullVersion: '1.2.9.1', requested: '' },
  { label: 'requested is the newest, installed unknown', gameVersion: undefined, fullVersion: undefined, requested: '2.0.0' },
]

const resolutionCases = []
for (const s of states) {
  const state = {}
  if (s.gameVersion !== undefined) state.gameVersion = s.gameVersion
  if (s.fullVersion !== undefined) state.fullVersion = s.fullVersion
  const resolution = mod.resolveBannerlordApiVersion(db, state, s.requested)
  resolutionCases.push({ ...s, resolution })
}

// The same resolution against an EMPTY database, to pin the "nothing indexed" branch that the
// populated one cannot reach.
const emptyDbPath = join(fixturesDir, 'apidocs-empty.db')
removeOwnFixtureOrRefuse(emptyDbPath, 'gen_apidocs_fixtures.mjs')
const emptyDb = new Database(emptyDbPath)
emptyDb.run(`CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)`)
markAsFixture(emptyDb, 'gen_apidocs_fixtures.mjs')

const emptyCases = [
  { label: 'empty index, nothing requested', gameVersion: undefined, fullVersion: undefined, requested: undefined },
  { label: 'empty index, something requested', gameVersion: '1.2.9', fullVersion: undefined, requested: '1.2.9' },
].map(s => {
  const state = {}
  if (s.gameVersion !== undefined) state.gameVersion = s.gameVersion
  if (s.fullVersion !== undefined) state.fullVersion = s.fullVersion
  return { ...s, resolution: mod.resolveBannerlordApiVersion(emptyDb, state, s.requested) }
})

const fixtures = {
  _comment:
    'GENERATED by gen_apidocs_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/bannerlord-api-docs.ts. Do not edit by hand.',
  dbPath: 'tools/parity/fixtures/apidocs.db',
  emptyDbPath: 'tools/parity/fixtures/apidocs-empty.db',
  indexedVersions: mod.readIndexedApiVersions(db),
  sections: mod.BANNERLORD_API_SECTIONS,
  normalizeCases,
  compareCases,
  resolutionCases,
  emptyCases,
}
writeFileSync(join(here, 'apidocs_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote apidocs_fixtures.json + fixtures/apidocs.db + fixtures/apidocs-empty.db')
console.log('  normalizeApiVersion : ' + normalizeCases.length)
console.log('  compareApiVersions  : ' + compareCases.length)
console.log('  resolutions         : ' + resolutionCases.length)
console.log('  empty-index cases   : ' + emptyCases.length)
console.log('')
console.log('  ★ readIndexedApiVersions (inserted 1.2.9 / 1.9.0 / 1.10.0 / 2.0.0):')
console.log('      ' + JSON.stringify(mod.readIndexedApiVersions(db)))
console.log('    (a TEXTUAL sort would put 1.10.0 before 1.9.0)')
