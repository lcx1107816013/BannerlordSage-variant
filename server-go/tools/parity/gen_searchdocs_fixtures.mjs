// Parity fixture generator for src/tools/search-docs.ts -> tools.SearchDocs.
//
// The corpus is a crafted FTS5 database, and the expectations are the TypeScript's rendered text
// against that same committed database. It separates rules rather than looking realistic:
//
//   * one row whose body is EMPTY and one whose body is NULL — measured, `snippet()` returns "" for
//     the first and NULL for the second, and both are what `row.snippet || '(no snippet)'` catches.
//     The REAL index never stores an empty body (0 of 1355 rows checked), so only a crafted corpus
//     reaches this branch
//   * a token shared by one row of EACH source, so the filter mapping is visible as a count: the
//     unfiltered search returns 3 rows and a single-source filter returns 1. Without a cross-source
//     token the mapping is invisible and a wrong mapping goes unnoticed
//   * limit values 0, -3 and 99, which pin the clamp's lower bound, its ceiling and the fact that a
//     NEGATIVE limit becomes the floor rather than the default
//
// ★ THE api-docs HALF LIVES IN ITS OWN GENERATOR. search_api_docs calls getDb('bannerlord') with the
// id HARD-CODED, so it cannot be redirected through the environment; gen_searchapidocs_fixtures.mjs
// exercises it by replacing its three I/O modules at the module level, which keeps the function
// under test REAL. See that file for why writing a corpus to dist/games/bannerlord was not an option
// (ledger F19).
//
// Usage: bun run server-go/tools/parity/gen_searchdocs_fixtures.mjs

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync } from 'node:fs'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── docs database ────────────────────────────────────────────────────────────
const docsPath = join(fixturesDir, 'searchdocs.db')
// Refuses rather than deleting anything this harness did not mark. See fixture_guard.mjs.
removeOwnFixtureOrRefuse(docsPath, 'gen_searchdocs_fixtures.mjs')
const docsDb = new Database(docsPath)
docsDb.run(`CREATE TABLE bannerlord_docs (
  id TEXT PRIMARY KEY, source TEXT, language TEXT, category TEXT, title TEXT, url TEXT, body TEXT
)`)
docsDb.run(`CREATE VIRTUAL TABLE bannerlord_docs_fts USING fts5(
  id UNINDEXED, source UNINDEXED, language UNINDEXED, category UNINDEXED, title, url UNINDEXED, body,
  content='bannerlord_docs', content_rowid='rowid', tokenize='unicode61'
)`)
// The external-content FTS table needs its index populated through the rename trick, which is what
// the real indexer does; the 'rebuild' command is the supported way.
const insertDoc = docsDb.query(`INSERT INTO bannerlord_docs (id, source, language, category, title, url, body) VALUES (?,?,?,?,?,?,?)`)
insertDoc.run('d1', 'own_knowledge', 'en', 'guide', 'Gauntlet UI basics', 'https://x/1', 'How to bind a gauntlet widget to a view model. zebracrossing.')
insertDoc.run('d2', 'own_knowledge', 'en', 'guide', 'Sandbox module anatomy', 'https://x/2', 'A module needs a SubModule xml and a dll.')
insertDoc.run('d3', 'official_moddocs', 'en', 'reference', 'CampaignSystem events', 'https://x/3', 'Event hooking for campaign behaviour. zebracrossing.')
insertDoc.run('d4', 'community_modding_docs', 'en', 'tutorial', 'Harmony patching', 'https://x/4', 'Prefix and postfix patches explained. zebracrossing.')
// A row whose ONLY searchable text is outside the snippet column window, and two rows whose body
// is EMPTY and NULL: measured, `snippet()` returns "" for an empty column and NULL for a NULL one,
// and those are the two inputs the `row.snippet || '(no snippet)'` guard exists for. The real index
// never stores an empty body (checked: 0 of 1355 rows), so this branch is reachable only from a
// crafted corpus — which is exactly why a corpus that looked realistic would not cover it.
insertDoc.run('d5', 'own_knowledge', 'en', 'note', 'Widget', 'https://x/5', 'gauntlet')
insertDoc.run('d6', 'own_knowledge', 'en', 'note', '', 'https://x/6', 'gauntlet')
insertDoc.run('d7', 'own_knowledge', 'en', 'note', 'Emptysnippet gadget', 'https://x/7', '')
insertDoc.run('d8', 'own_knowledge', 'en', 'note', 'Nullsnippet gadget', 'https://x/8', null)
markAsFixture(docsDb, 'gen_searchdocs_fixtures.mjs')
docsDb.run(`INSERT INTO bannerlord_docs_fts(bannerlord_docs_fts) VALUES('rebuild')`)

// ── the api-docs half is NOT generated here ─────────────────────────────────
//
// search_api_docs calls getDb('bannerlord') / getGamePaths('bannerlord') with the id HARD-CODED, so
// BANNERSAGE_GAME cannot redirect it. Exercising it would mean writing a fixture database to
// dist/games/bannerlord/bannerlord.db, which on this machine IS the real 600 MB index — the exact
// write that destroyed it once (ledger F19). The tool's TypeScript is about to be replaced by
// src/ rewrite work, so patching it here to add an override would edit the reference tree the
// differential depends on.
//
// The Go port of search_api_docs is therefore SHIPPED UNCOVERED BY THIS HARNESS, and the reason is
// recorded in the fixture file and in the commit message rather than papered over with a corpus
// that does not exercise it. The version-resolution half — which is where the branch logic lives —
// IS covered, by gen_apidocs_fixtures.mjs against two dedicated databases.

// ── run the real TypeScript ──────────────────────────────────────────────────
const docsMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'search-docs.ts')).href)

// The tool resolves its database from getDb(), which reads the ACTIVE GAME ID. A synthetic id keeps
// the fixture away from the real index (the F19 discipline), and the fixture db is copied to the
// path the tool will then resolve.
const SYNTH_ID = 'blore-fixture-searchdocs'
const synthDir = join(repoRoot, 'dist', 'games', SYNTH_ID)
mkdirSync(synthDir, { recursive: true })
process.env.BANNERSAGE_GAME = SYNTH_ID

const { copyFileSync } = await import('node:fs')
copyFileSync(docsPath, join(synthDir, SYNTH_ID + '.db'))

const docsCases = []
for (const [query, source, limit] of [
  ['gauntlet', 'own', 8],
  ['gauntlet', 'all', 8],
  // One row per source carries 'zebracrossing', so these four differ by COUNT: unfiltered 3,
  // single-source 1. A wrong mapping changes the count and is therefore visible.
  ['zebracrossing', 'all', 8],
  ['zebracrossing', 'own', 8],
  ['zebracrossing', 'official', 8],
  ['zebracrossing', 'community', 8],
  ['zebracrossing', 'bogus', 8],
  // 'gadget' hits the empty-body and NULL-body rows: the (no snippet) guard.
  ['gadget', 'own', 8],
  ['gadget', 'all', 8],
  ['gauntlet', 'official', 8],
  ['gauntlet', 'community', 8],
  ['gauntlet', 'bogus', 8],
  ['module', 'own', 8],
  ['', 'own', 8],
  ['"quoted"', 'own', 8],
  ['nomatchanywhere', 'own', 8],
  ['gauntlet', 'own', 1],
  ['gauntlet', 'own', 0],
  ['gauntlet', 'own', -3],
  ['gauntlet', 'own', 99],
]) {
  let entry
  try {
    const res = await docsMod.searchDocs(query, source, limit)
    entry = { query, source, limit, ok: true, text: res.content[0].text }
  } catch (error) {
    entry = { query, source, limit, ok: false, error: String(error?.message ?? error) }
  }
  docsCases.push(entry)
}

const fixtures = {
  _comment:
    'GENERATED by gen_searchdocs_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/tools/search-docs.ts against a crafted FTS5 corpus. Do not edit by hand. ' +
    'search_api_docs is NOT covered here: its database id is hard-coded, so a corpus would require ' +
    'writing to the real index path (ledger F19). See gen_apidocs_fixtures.mjs and the direct Go ' +
    'tests in searchdocs_parity_test.go for that tool.',
  docsDbPath: 'tools/parity/fixtures/searchdocs.db',
  docsCases,
}
writeFileSync(join(here, 'searchdocs_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote searchdocs_fixtures.json + fixtures/searchdocs.db')
console.log('  docs cases : ' + docsCases.length + ' (' + docsCases.filter(c => c.ok).length + ' rendered)')
console.log('')
console.log('  the api half is covered by gen_searchapidocs_fixtures.mjs (module-level injection).')
