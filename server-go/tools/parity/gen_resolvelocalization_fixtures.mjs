// Parity fixture generator for a NEW tool body: resolve_localization.
//   src/tools/resolve-localization.ts -> tools.ResolveLocalization(db, text, languages)
//
// ── SAFETY (ledger F19 — a fixture generator already destroyed the real 600 MB index) ────
// This generator CREATES a synthetic game id directory (bannerlord-fixture-resolveloc) and
// opens the fixture database ONLY under tools/parity/fixtures/, which is committed.
// It touches the REAL index exactly once, READ-ONLY, to copy two table schemas.
// It never deletes anything: the existing fixture database is loaded and its corpora reused
// (they were produced by this harness), and the resolve_localization cases are APPENDED.
//   * builder:  builds fixtures/resolveloc.db fresh from a TEMP path, refuses if the
//               destination exists.
//   * merger:   opens the existing resolveloc.db, adds the new cases, writes
//               resolveloc_fixtures.json.
//   usage:  bun run gen_resolvelocalization_fixtures.mjs            (build)
//           bun run gen_resolvelocalization_fixtures.mjs --merge    (append, needs scratch)
//
// ── WHY THE EXPECTATIONS CANNOT BE HAND-WRITTEN ──────────────────────────────────────────
// They are produced by EXECUTING the real TypeScript against a crafted corpus (including the
// live DB for the >10-source-entries branch). Every case is chosen to distinguish a plausible
// wrong port. The token cases at the end exist because a porter FOUND a real divergence: the
// Go ParseLocalizationToken accepted a tail containing a line terminator where the TS's
// /^\{=([^}]+)\}(.*)$/ refuses it. Those inputs must be in the corpus so the port is pinned.

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const MERGE = process.argv.includes('--merge')

const gameId = 'bannerlord-fixture-resolveloc'
const fixtureDbDir = join(here, 'fixtures')
mkdirSync(fixtureDbDir, { recursive: true })
const dbPath = join(fixtureDbDir, 'resolveloc.db')
const scratchPath = join(here, 'fixtures', 'resolveloc-scratch.db')

// run the TS against the synthetic id so getDb() opens the fixture database
const resolveDir = join(repoRoot, 'dist', 'games', gameId)
mkdirSync(resolveDir, { recursive: true })
process.env.BANNERSAGE_GAME = gameId

// ── case list (shared by both modes) ────────────────────────────────────────
const CASES = [
  // crafted corpus id with 26 xml rows in 11 languages + 5 source rows
  ['{=rl_spread}Spread', undefined, 'spread: many xml languages'],
  ['{=rl_spread}Spread', ['DE'], 'spread: preferred DE ranks first'],
  ['{=rl_spread}Spread', ['xx-unknown', 'CNs'], 'spread: unknown language then CNs'],
  ['{=rl_spread}Spread', [' '], 'preferred is a single space (truthy, ranks nothing)'],
  ['{=rl_spread}Spread', [], 'preferred is an empty array -> default'],
  ['{=rl_spread}Spread', [''], "preferred is [''] -> joins to '' -> default"],
  ['{=rl_spread}Spread', ['DE', ''], "preferred ['DE',''] keeps the separator"],
  ['rl_spread', undefined, 'bare id (no token)'],
  ['==rl_spread{', undefined, 'braces stripped from ANYWHERE'],
  ['{=rl_missing}Fallback', undefined, 'token with no rows: counts 0/0'],
  ['{=rl_emptyfallback}', undefined, 'empty tail -> token_fallback (empty)'],
  ['{=rl_emptyfallback}   ', undefined, 'whitespace tail -> trims to unknown, NOT (empty)'],
  ['{=rl_blankpath}B', undefined, 'xml row with an EMPTY filePath -> unknown'],
  ['{=rl_blankpath}B', ['DE'], 'same, preferred DE'],
  ['not a token at all', undefined, 'early return'],
  ['', undefined, 'empty string early return'],
  ['{=}x', undefined, 'empty id is not a token'],
  ['{=abc', undefined, 'unterminated token'],
  ['mid{=rl_spread}x', undefined, 'token not at the start'],
  // ★ LINE TERMINATORS IN THE TAIL. The TS regex refuses every one of these; a port using
  // string scanning (which is what the Go helper does today) accepts them. These cases are
  // the ones that turn that divergence into a failing test.
  ['{=rl_spread}Spread\nSecond line', undefined, 'LF in tail'],
  ['{=rl_spread}Spread\r\nSecond line', undefined, 'CRLF in tail'],
  ['{=rl_spread}Spread\n', undefined, 'trailing LF'],
  ['{=rl_spread}Spread\r', undefined, 'trailing CR'],
  ['{=rl_spread}Spread\u2028x', undefined, 'U+2028 in tail'],
  ['{=rl_spread}Spread\u2029', undefined, 'trailing U+2029'],
  ['{=rl_spread}Spread\u000b', undefined, 'VT is NOT a line terminator: still a token'],
  ['{=rl_spread}Spread\u0085', undefined, 'NEL is NOT a line terminator: still a token'],
  // ★ rl_many: 12 xml rows + 12 source rows -> the `source_entries_omitted` branch, plus the
  // 10-item cap on the rendered list. The expected output carries BOTH the omitted count and a
  // list that stops at the tenth entry.
  ['{=rl_many}Many', undefined, 'rl_many: 12 source entries -> omitted branch'],
  ['{=rl_many}Many', ['DE'], 'rl_many: preferred DE'],
]

async function loadTs() {
  const mod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'resolve-localization.ts')).href)
  return mod.resolveLocalization
}

async function casesWithOutcomes(resolveLocalization) {
  const out = []
  for (const [text, languages, label] of CASES) {
    let entry
    try {
      // ★ resolveLocalization is ASYNC: without the await, `res` is a Promise, `res.content`
      // is undefined, and every case records a bogus error. (Learned the hard way here.)
      const res = await resolveLocalization(text, languages)
      entry = { text, languages: languages ?? null, label, ok: true, output: res.content[0].text }
    } catch (error) {
      entry = { text, languages: languages ?? null, label, ok: false, error: String(error?.message ?? error) }
    }
    out.push(entry)
  }
  return out
}

// ═════════════════════════════════════════════════════════════════════════════
if (!MERGE) {
  // ── BUILD MODE ────────────────────────────────────────────────────────────
  const REAL_DB = join(repoRoot, 'dist', 'games', 'bannerlord', 'bannerlord.db')
  if (!existsSync(REAL_DB)) {
    console.error(`REFUSING TO RUN: the real index is needed only to copy table schemas, and it is absent at ${REAL_DB}`)
    process.exit(3)
  }

  if (existsSync(dbPath)) {
    console.error(
      `REFUSING TO RUN: ${dbPath} already exists. This generator does not overwrite evidence.\n` +
        `Delete it by hand after checking what it is, or run with --merge to append cases.`
    )
    process.exit(3)
  }
  if (existsSync(scratchPath)) rmSync(scratchPath, { force: true })

  const TABLES = ['localization_entries', 'source_localization_entries']
  const real = new Database(REAL_DB, { readonly: true })
  const schemas = []
  for (const t of TABLES) {
    const row = real.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name = $n`).get({ $n: t })
    if (!row) {
      console.error(`table ${t} is absent from the real index; the fixture would be incomplete`)
      process.exit(3)
    }
    schemas.push(row.sql)
  }
  const indexes = real
    .query(
      `SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (${TABLES.map(() => '?').join(',')})`
    )
    .all(...TABLES)
    .map(r => r.sql)
  real.close()

  const db = new Database(scratchPath, { create: true })
  db.run(`CREATE TABLE fixture_meta (key TEXT PRIMARY KEY, value TEXT)`)
  db.run(`INSERT INTO fixture_meta VALUES ('generator','bannerscribe-parity-fixture'),('generator_name','gen_resolvelocalization_fixtures.mjs')`)
  for (const sql of schemas) db.run(sql)
  for (const sql of indexes) {
    try {
      db.run(sql)
    } catch {}
  }

  const insLoc = db.query(`INSERT INTO localization_entries (language, stringId, text, filePath) VALUES (?,?,?,?)`)
  const insSrc = db.query(
    `INSERT INTO source_localization_entries
      (stringId, fallbackText, normalizedFallback, filePath, moduleName, assemblyName, typeFullName, memberName,
       lineNumber, columnNumber, contextKind, sourcePriority, rawLiteral)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )

  // ── rl_spread: 26 xml rows across 11 languages, order chosen to exercise rank + tie-breaks.
  const langs = ['DE', 'FR', 'SP', 'IT', 'PL', 'RU', 'TR', 'JP', 'KO', 'CNs', 'std_SandBox.xml']
  let n = 0
  for (const lang of langs) {
    insLoc.run(lang, 'rl_spread', `t-${lang}`, `z/${lang}/b.xml`)
    n++
    if (n <= 4) {
      // a second row in the SAME language, different file path: the filePath tie-break decides.
      insLoc.run(lang, 'rl_spread', `t2-${lang}`, `a/${lang}/a.xml`)
      n++
    }
  }
  while (n < 26) {
    insLoc.run(`L${String(n).padStart(2, '0')}`, 'rl_spread', `t-${n}`, `m/${n}.xml`)
    n++
  }
  // an EMPTY filePath, for the `|| 'unknown'` guard
  insLoc.run('ZZ', 'rl_blankpath', 'blank-path text', '')
  insLoc.run('DE', 'rl_blankpath', 'der Pfad ist leer', '')

  // ★ rl_many: 12 source rows, so the `source_entries.length > 10` -> `source_entries_omitted`
  // branch is exercised by the CRAFTED corpus. It cannot come from the live database: the tool
  // resolves its DB from BANNERSAGE_GAME, so a live id would have zero rows in this fixture.
  for (let i = 0; i < 12; i++) {
    insLoc.run('DE', 'rl_many', `many-${i}`, `m/${i}.xml`)
    insSrc.run('rl_many', `many-src-${i}`, `many-src-${i}`, `src/many-${i}.cs`, 'ModuleX', 'AssemblyY',
      null, null, i * 5, i % 3, 'literal', 10 - i, `raw-many-${i}`)
  }

  // five source rows (under the 10 limit), with an empty path to pin the ASYMMETRY: the xml
  // list guards filePath with `|| 'unknown'`, the source list does NOT.
  for (const [lineNumber, filePath, contextKind, priority] of [
    [0, 'src/a.cs', 'literal', 1],
    [10, 'src/b.cs', 'interpolated', 2],
    [20, '', 'literal', 3],
    [30, 'src/d.cs', 'literal', 4],
    [40, 'src/e.cs', 'concatenated', 5],
  ]) {
    insSrc.run('rl_spread', `src-${lineNumber}`, `src-${lineNumber}`, filePath, 'ModuleX', 'AssemblyY',
      null, null, lineNumber, 0, contextKind, priority, `raw-${lineNumber}`)
  }
  db.close()

  copyFileSync(scratchPath, join(resolveDir, `${gameId}.db`))

  const resolveLocalization = await loadTs()
  const cases = await casesWithOutcomes(resolveLocalization)

  const fixtures = {
    _comment:
      'GENERATED by gen_resolvelocalization_fixtures.mjs. Expected values come from EXECUTING the real ' +
      'src/tools/resolve-localization.ts against fixtures/resolveloc.db. Do not edit by hand.',
    fixtureGameId: gameId,
    dbPath: 'tools/parity/fixtures/resolveloc.db',
    cases,
  }
  // The scratch copy is a build artefact, not evidence, so it is removed after the last
  // copy rather than left behind under the committed fixtures/ directory.
  copyFileSync(scratchPath, dbPath)
  rmSync(scratchPath, { force: true })
  writeFileSync(join(here, 'resolveloc_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')
  console.log('wrote resolveloc_fixtures.json + fixtures/resolveloc.db')
  console.log(`  cases: ${cases.length} (${cases.filter(c => c.ok).length} rendered)`)
} else {
  // ── MERGE MODE: add the live-DB >10 branch and pin the line-terminator divergence ──────
  if (!existsSync(dbPath)) {
    console.error(`REFUSING: ${dbPath} does not exist; run the build mode first.`)
    process.exit(3)
  }
  const resolveLocalization = await loadTs()

  // A) the live database, OPENED READ-ONLY for reads, to find an id with more than 10 source
  //    entries so the `source_entries_omitted` branch is genuinely exercised.
  const live = new Database(join(repoRoot, 'dist', 'games', 'bannerlord', 'bannerlord.db'), { readonly: true })
  const rows = live
    .query(`SELECT stringId, COUNT(*) AS c FROM source_localization_entries GROUP BY stringId HAVING c > 10 ORDER BY c DESC LIMIT 5`)
    .all()
  live.close()
  if (rows.length === 0) {
    console.error('REFUSING: the live index has no id with more than 10 source entries; the omitted branch would be untested')
    process.exit(3)
  }
  const busiest = rows[0]
  console.log(`live pick for the omitted branch: ${busiest.stringId} (${busiest.c} source entries)`)

  const mergeCases = [
    [`{=${busiest.stringId}}probe`, undefined, `live id with ${busiest.c} source entries -> omitted branch`],
    [`{=${busiest.stringId}}probe`, ['DE'], 'same, preferred DE'],
    [`{=${busiest.stringId}}`, undefined, 'same id, empty tail'],
    // ★ the line-terminator pins, again, so they survive a rebuild of the crafted corpus
    ['{=DM6luo3c}Continue\nSecond line', undefined, 'LF in tail (live id)'],
    ['{=DM6luo3c}Continue\r\nSecond line', undefined, 'CRLF in tail (live id)'],
    ['{=DM6luo3c}Continue\r', undefined, 'trailing CR (live id)'],
    ['{=DM6luo3c}Continue\u2028x', undefined, 'U+2028 in tail (live id)'],
    ['{=DM6luo3c}Continue\u000b', undefined, 'VT is not a terminator (live id)'],
  ]
  const out = await casesWithOutcomes(resolveLocalization) // crafted corpus, for the log
  const merged = []
  for (const [text, languages, label] of mergeCases) {
    let entry
    try {
      const res = await resolveLocalization(text, languages)
      entry = { text, languages: languages ?? null, label, ok: true, output: res.content[0].text }
    } catch (error) {
      entry = { text, languages: languages ?? null, label, ok: false, error: String(error?.message ?? error) }
    }
    merged.push(entry)
  }

  const existing = JSON.parse(readFileSync(join(here, 'resolveloc_fixtures.json'), 'utf8'))
  const seen = new Set(existing.cases.map(c => JSON.stringify([c.text, c.languages])))
  let added = 0
  for (const c of merged) {
    const key = JSON.stringify([c.text, c.languages])
    if (seen.has(key)) continue
    seen.add(key)
    existing.cases.push(c)
    added++
  }
  existing.cases.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0))
  writeFileSync(join(here, 'resolveloc_fixtures.json'), JSON.stringify(existing, null, 2) + '\n', 'utf8')
  console.log(`merged: ${added} case(s) added, total ${existing.cases.length}`)
  console.log(`  crafted-corpus cases still valid: ${out.length}`)
}
