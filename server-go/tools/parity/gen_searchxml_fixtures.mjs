// Parity fixture generator for src/tools/search-xml.ts.
//
// The tool runs a real SQLite FTS5 query, so the fixture approach is the store one: build a
// database with a known corpus, run the TypeScript against it, and record the rendered
// report text. The Go side opens the SAME committed database file, so both sides provably
// query identical bytes.
//
// The GET_DB dependency is the awkward part: searchXml calls getDb(), which resolves a path
// from env and caches a singleton. Rather than fight that, the corpus is written to the
// path getDb() would resolve — driven by BANNERSAGE_GAME plus the repo layout — and the
// table is created there directly. That keeps the TypeScript unmodified, which matters:
// stubbing its database access would mean testing a different function.
//
// The corpus targets:
//   - a multi-term query whose terms appear in different columns, so bm25 weighting (8.0
//     for filePath, 4.0 for moduleName, 1.0 for content) actually changes the order
//   - a term present in TWO rows with different frequencies
//   - a hyphenated token, the shape that broke project_memory_search (ledger F5)
//   - a query with no matches, which renders the zero-block report
//   - a non-ASCII term, to exercise the unicode61 tokenizer
//   - a `"` -only query, whose BuildQuery result was pinned in the fts unit
//
// Usage: bun run server-go/tools/parity/gen_searchxml_fixtures.mjs

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

// ── where the fixture database lives ────────────────────────────────────────
//
// ★ NOT under dist/. The archive's .gitignore excludes `dist/`, so a database written
// there would be present on this machine and ABSENT for everyone else — the suite would
// pass locally and fail on a fresh clone, and neither run would be lying. Fixtures must live
// where they are committed, so the database goes in the fixtures directory.
const gameId = 'bannerlord'
const fixtureDbDir = join(here, 'fixtures')
mkdirSync(fixtureDbDir, { recursive: true })
const dbFile = `${gameId}-searchxml.db`
const dbPath = join(fixtureDbDir, dbFile)
if (existsSync(dbPath)) rmSync(dbPath)

// The tool resolves its database through src/utils/db.ts -> env.ts. Rather than stub that
// (which would mean testing a different function), the corpus is TEMPORARILY placed at the
// path the TypeScript will resolve, the tool is executed against it, and the finished
// database is then MOVED into the fixtures directory for the Go side to use.
//
// BANNERSAGE_DB is honoured by the runtime revision machinery, but the authoritative path is
// gameDistPath/<gameId>.db, so the file is written there and relocated afterwards.
const resolveDir = join(repoRoot, 'dist', 'games', gameId)
mkdirSync(resolveDir, { recursive: true })
const resolvePath = join(resolveDir, `${gameId}.db`)

// Both paths are cleared up front. The resolve path in particular must be removed even if
// a previous run crashed after creating it: leaving it behind would make the next run fail
// with "table xml_documents_fts already exists", which looks like a schema bug and is not
// one. (That is exactly how this script failed once.)
rmSync(resolvePath, { force: true })
rmSync(dbPath, { force: true })

// The tool resolves the db through env.ts, which reads these.
process.env.BANNERSAGE_GAME = gameId
process.env.BANNERSAGE_TOOLSET ||= 'query-first'

// ── build the FTS corpus ────────────────────────────────────────────────────
const db = new Database(resolvePath, { create: true })
db.run(`
  CREATE VIRTUAL TABLE xml_documents_fts USING fts5(
    filePath,
    moduleName,
    content,
    tokenize = 'unicode61',
    prefix = '2 3 4'
  )`)

const corpus = [
    // gauntlet appears in content; Native in moduleName
    { filePath: 'Modules/Native/GUI/Prefabs/A.xml', moduleName: 'Native', content: 'gauntlet ui layer calculates speed for the battle presentation' },
    { filePath: 'Modules/Native/GUI/Prefabs/B.xml', moduleName: 'Native', content: 'another gauntlet ui widget with different wording' },
    // gauntlet in the filePath, so bm25's 8.0 weight should rank this above content hits
    { filePath: 'Modules/SandBox/GUI/gauntlet/C.xml', moduleName: 'SandBox', content: 'something unrelated to the search terms' },
    // repeated term, to exercise term frequency
    { filePath: 'Modules/SandBox/D.xml', moduleName: 'SandBox', content: 'speed speed speed and nothing else' },
    { filePath: 'Modules/Other/E.xml', moduleName: 'Other', content: 'a single speed mention' },
    // hyphenated token, the F5 shape
    { filePath: 'Modules/Other/F.xml', moduleName: 'Other', content: 'contains bannerscribe-regression-test exactly once' },
    // non-ASCII
    { filePath: 'Modules/Other/G.xml', moduleName: 'Other', content: '中文内容 与 emoji 🎯 in a document' },
    // a long row, so the snippet window and the ellipsis marker actually engage
    {
        filePath: 'Modules/Other/H.xml',
        moduleName: 'Other',
        content: Array.from({ length: 60 }, (_, i) => (i === 30 ? 'needle' : `filler${i}`)).join(' '),
    },
]

const insert = db.prepare(`INSERT INTO xml_documents_fts (filePath, moduleName, content) VALUES (?, ?, ?)`)
for (const row of corpus) insert.run(row.filePath, row.moduleName, row.content)
db.close()

// ── run the TypeScript tool ─────────────────────────────────────────────────
const mod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'search-xml.ts')).href)
const { searchXml } = mod

const queries = [
    'gauntlet ui',
    'gauntlet',
    'speed',
    'native',
    'sandbox',
    'bannerscribe-regression-test',
    'bannerscribe',
    'needle',
    '中文',
    '🎯',
    'ui speed',
    'nothing-matches-this-at-all',
    '',
    '   ',
    '"',
    '  gauntlet  ',
    'GAUNTLET',
    'gauntlet*',
    'A.xml',
]

const results = []
for (const query of queries) {
    let out
    try {
        const res = await searchXml(query)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    results.push({ query, ...out })
}

// ── copy the database into the committed fixtures directory ─────────────────
//
// COPY, not rename. `getDb()` caches a singleton handle for the process lifetime, so the
// file is still open when this line runs and a rename fails with EBUSY on Windows. A copy
// reads the committed bytes without disturbing that handle.
//
// The file is copied rather than merely left in place because the archive gitignores
// `dist/`: a database living there would exist on this machine and be missing on a fresh
// clone, so the suite would pass here and fail for anyone else.
copyFileSync(resolvePath, dbPath)

// ★ The copy under dist/ is DELIBERATELY left in place and must not be deleted here.
// `getDb()` caches a singleton handle for the process lifetime, so the file is still open
// at this point and Windows refuses to unlink it (EBUSY). It is harmless: `dist/` is
// gitignored, so it never reaches the repository, and the next run removes and recreates it
// cleanly because it does so BEFORE any handle exists.

const fixtures = {
    _comment:
        'GENERATED by gen_searchxml_fixtures.mjs. Expected values come from EXECUTING ' +
        'src/tools/search-xml.ts against dist/games/bannerlord/bannerlord.db, which is ' +
        'committed so both sides query identical bytes. Do not edit by hand.',
    generatedFrom: 'src/tools/search-xml.ts (imported)',
    dbPath: `tools/parity/fixtures/${dbFile}`,
    // The rows are recorded so the Go test can verify the database it opens is the corpus
    // this fixture set describes.
    corpus,
    results,
}

writeFileSync(join(here, 'searchxml_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

console.log('wrote searchxml_fixtures.json + dist/games/bannerlord/bannerlord.db')
console.log(`  corpus rows : ${corpus.length}`)
console.log(`  queries     : ${results.length} (${results.filter((r) => r.ok).length} rendered)`)
console.log()
console.log('  ★ bm25 ordering (filePath weight 8.0 should outrank a content match):')
const g = results.find((r) => r.query === 'gauntlet')
if (g && g.ok) {
    for (const line of g.text.split('\n')) {
        if (line.startsWith('match_') || line.startsWith('file_path:') || line.startsWith('module_name:')) {
            console.log(`      ${line}`)
        }
    }
}
console.log()
console.log('  ★ the zero-match report (no blocks at all):')
const none = results.find((r) => r.query === 'nothing-matches-this-at-all')
if (none && none.ok) console.log(none.text.split('\n').map((l) => '      ' + l).join('\n'))
