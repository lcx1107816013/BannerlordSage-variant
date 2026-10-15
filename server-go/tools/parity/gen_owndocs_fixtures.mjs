// Parity fixture generator for:
//   src/utils/docs-db.ts -> docsdb (schema, MakeDocId, upsert/insert/delete behaviour)
//   src/utils/own-docs.ts -> owndocs (walk, split, slugify, title, row building)
//
// The markdown corpus is written to a fixture tree and the REAL module reads it, so every
// expectation comes from executing the original rather than from reading it. The corpus is built to
// separate rules:
//
//   * frontmatter that is malformed in the three ways the strip function treats differently:
//     no leading `---`, an opening delimiter with no closing one, and a closing one with no newline
//     after it
//   * a `## ` line with nothing after it (which does NOT become a heading)
//   * a `### ` line (three hashes, still body text)
//   * a heading with interior and trailing whitespace, to separate the two trims
//   * a CJK heading (kept in the slug) and a kana heading (dropped, so the slug falls back)
//   * a section whose body is empty, and a document that is entirely empty
//   * a `.MD` file (uppercase extension, still matched) and a `.txt` (not matched)
//   * a hidden directory and a hidden file, which the walk skips
//   * a duplicate path reached through two configured directories, which the dedupe collapses
//
// Usage: bun run server-go/tools/parity/gen_owndocs_fixtures.mjs

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the markdown tree ───────────────────────────────────────────────────────
// ★ THE TREE IS EMITTED AS SHAPE DATA AND REBUILT BY THE GO TEST. It cannot be committed: one case
// needs a HIDDEN DIRECTORY (which git would track only with a file inside, defeating the case) and
// the whole point is the exact set of paths the walker sees. See
// fixtures/.gitignore's note for the same reasoning applied to the runtime-check trees.
const tree = join(fixturesDir, 'owndocs-tree')
if (existsSync(tree)) rmSync(tree, { recursive: true, force: true })
const mk = p => mkdirSync(join(tree, ...p.split('/')), { recursive: true })
const wf = (p, content) => {
  const full = join(tree, ...p.split('/'))
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

const SHAPE = {
  dirs: [
    'knowledge',
    'knowledge/modding',
    'knowledge/modding/deeper',
    'knowledge/.hidden-dir',
    'knowledge/suite',
    'extra',
  ],
  files: {
    // 1. plain document: intro + two sections
    'knowledge/plain.md': [
      '# Plain Guide',
      '',
      'Intro text.',
      '',
      '## First Section',
      '',
      'Body of the first.',
      '',
      '## Second Section',
      '',
      'Body of the second.',
      '',
    ].join(NL),
    // 2. frontmatter, well formed
    'knowledge/frontmatter.md': [
      '---',
      'title: Front',
      'tags: [a, b]',
      '---',
      '# Front Matter Doc',
      '',
      'Body after frontmatter.',
      '',
      '## Section A',
      '',
      'A body.',
    ].join(NL),
    // 3. frontmatter with NO newline after the closing delimiter
    'knowledge/unterminated.md': '---' + NL + 'title: x' + NL + '---',
    // 4. opening --- but never closed
    'knowledge/unclosed.md': '---' + NL + 'title: y' + NL + 'no closer here',
    // 5. the `---` appears but not at the start
    'knowledge/not-at-start.md': 'text' + NL + '---' + NL + 'title: z' + NL + '---' + NL + 'body',
    // 6. heading edge cases.
    //
    // ★ THE WHITESPACE RUN LENGTH IS THE VARIABLE, so it is ENUMERATED rather than sampled. A `##`
    // line with ONE whitespace character is body text while TWO OR MORE make a heading whose text is
    // the last whitespace character — and I had initially recorded the wrong rule because I measured
    // only the one-space case.
    'knowledge/headings.md': [
      '# headings',
      '',
      '## ',
      'after a one-space heading line',
      '',
      '##  ',
      'after a two-space heading line',
      '',
      '##   ',
      'after a three-space heading line',
      '',
      '##		',
      'after a two-tab heading line',
      '',
      '### three hashes',
      'body after h3',
      '',
      '#### four hashes',
      'body after h4',
      '',
      '##Heading without a space',
      'body after that',
      '',
      '##   spaced   heading   ',
      'body after spaced',
      '',
      '## 中文标题',
      '正文',
      '',
      '## かなのかき',
      'kana body',
    ].join(NL),
    // 7. section with an empty body, and a document that is ONLY frontmatter
    'knowledge/empties.md': '# empties' + NL + '## Has Heading But No Body' + NL + '## Second Empty',
    'knowledge/only-frontmatter.md': '---' + NL + 'a: b' + NL + '---' + NL,
    // 8. a document with no heading at all
    'knowledge/no-heading.md': 'just text, no h1 no h2' + NL,
    // ★ AN H1 THAT IS PURE WHITESPACE. The regex MATCHES (`#  ` is two characters of whitespace) and
    // the caller trims the capture to "", so titleFromFile returns an EMPTY title rather than falling
    // back to the path — because it tests the MATCH, not the trimmed text.
    'knowledge/blank-h1.md': '#  ' + NL + 'body after a blank h1' + NL,
    'knowledge/one-space-h1.md': '# ' + NL + 'body after a one-space h1' + NL,
    // 9. uppercase extension
    'knowledge/UPPER.MD': '# Upper Case Extension' + NL + 'body' + NL,
    // 10. not markdown at all
    'knowledge/notes.txt': '# Not Markdown' + NL + 'body' + NL,
    // 11. nested, to exercise the category rule
    'knowledge/modding/deeper/deep.md': '# Deep' + NL + '## Deep Section' + NL + 'deep body' + NL,
    // 12. hidden file and a file inside a hidden directory
    'knowledge/.hidden-file.md': '# Hidden File' + NL + 'should not be indexed' + NL,
    'knowledge/.hidden-dir/inside.md': '# Inside Hidden Dir' + NL + 'should not be indexed' + NL,
    // 13. duplicate content under a second configured directory
    'extra/extra-doc.md': '# Extra Doc' + NL + '## Extra Section' + NL + 'extra body' + NL,
  },
}

for (const d of SHAPE.dirs) mkdirSync(join(tree, ...d.split('/')), { recursive: true })
for (const [f, content] of Object.entries(SHAPE.files)) wf(f, content)

// ── run the real TypeScript ─────────────────────────────────────────────────
const docsDbMod = await import(u(join(repoRoot, 'src', 'utils', 'docs-db.ts')))
const ownDocsMod = await import(u(join(repoRoot, 'src', 'utils', 'own-docs.ts')))

// ── pure functions ──────────────────────────────────────────────────────────
const pureCases = []

// splitMarkdownIntoSections over every corpus document
for (const [rel, content] of Object.entries(SHAPE.files)) {
  if (!/\.md$/i.test(rel)) continue
  pureCases.push({ kind: 'sections', file: rel, result: ownDocsMod.splitMarkdownIntoSections(content) })
}

// stripFrontmatter on inputs chosen to separate the three malformed shapes
for (const [label, input] of [
  ['well formed', '---\na: b\n---\nbody'],
  ['no leading delimiter', 'body\n---\na: b\n---\nmore'],
  ['leading whitespace defeats it', ' ---\na: b\n---\nbody'],
  ['unclosed', '---\na: b\nno closer'],
  ['closer with no following newline', '---\na: b\n---'],
  ['closer at the very end', '---\na: b\n---\n'],
  ['empty string', ''],
  ['just dashes', '---'],
  ['crlf frontmatter', '---\r\na: b\r\n---\r\nbody'],
]) {
  pureCases.push({ kind: 'frontmatter', file: label, result: ownDocsMod.stripFrontmatter(input) })
}

// slugify over the shapes that decide the allowed set and the truncation
for (const input of [
  'First Section', 'Hello, World!', '  spaced  ', 'A--B', '---', '',
  '中文标题', 'かなのかき', 'Mixed 中文 and ascii', 'Ünïcödé', 'a'.repeat(120),
  '123 456', 'UPPER', 'trailing ---', '--- leading', 'a_b-c', 'emoji 😀 here',
]) {
  pureCases.push({ kind: 'slugify', file: input, result: ownDocsMod.slugify(input) })
}

// makeDocId: the separator is part of the input, so two sources get different ids for one url
const idCases = []
for (const [source, url] of [
  ['own_knowledge', 'knowledge://a.md#intro'],
  ['own_knowledge', 'knowledge://a.md#intro'],
  ['official_moddocs', 'knowledge://a.md#intro'],
  ['own_knowledge', ''],
  ['', 'x'],
  ['a|b', 'c'],
  ['own_knowledge', 'knowledge://中文.md#标题'],
]) {
  idCases.push({ source, url, id: docsDbMod.makeDocId(source, url) })
}

// ── titleFromFile, which needs a knowledge root ─────────────────────────────
const knowledgeRoot = join(tree, 'knowledge')
const titleCases = []
for (const [rel, content] of Object.entries(SHAPE.files)) {
  if (!/\.md$/i.test(rel)) continue
  const full = join(tree, ...rel.split('/'))
  titleCases.push({ file: rel, result: ownDocsMod.titleFromFile(content, full) })
}

// ── listOwnDocFiles / listOwnDocDirs ────────────────────────────────────────
// The module's own knowledgeRoot() points at the REPO, so the walk is driven through the public
// listOwnDocFiles with an explicit dir list instead — the same function the tools layer calls.
const walkCases = []
for (const [label, dirs] of [
  ['knowledge only', [knowledgeRoot]],
  ['knowledge + extra', [knowledgeRoot, join(tree, 'extra')]],
  ['a missing dir', [join(tree, 'does-not-exist')]],
  ['an empty list', []],
  ['the same dir twice (dedupe)', [knowledgeRoot, knowledgeRoot]],
  // ★ THE SAME DIRECTORY SPELLED WITH DIFFERENT CASE. The dedupe key is the LOWERCASED resolved
  // path, so both spellings describe one file and the second must not appear twice. On a
  // case-insensitive filesystem the directory exists under either spelling, which makes this the
  // real shape of the problem: a user listing the same folder twice in the environment variable.
  ['the same dir in different case (dedupe)', [knowledgeRoot, knowledgeRoot.toUpperCase()]],
]) {
  const files = ownDocsMod.listOwnDocFiles(dirs)
  walkCases.push({
    label,
    dirs,
    // Recorded RELATIVE to the fixture tree so the Go side can rebuild and compare the SET.
    files: files.map(f => f.slice(tree.length + 1).replace(/\\/g, '/')).sort(),
  })
}

// ── buildOwnDocRows ─────────────────────────────────────────────────────────
const files = ownDocsMod.listOwnDocFiles([knowledgeRoot, join(tree, 'extra')])
const rows = ownDocsMod.buildOwnDocRows(files, '2026-01-01T00:00:00.000Z')
const rowCases = rows.map(r => ({
  id: r.id,
  source: r.source,
  language: r.language,
  category: r.category,
  title: r.title,
  url: r.url,
  content: r.content,
  indexedAt: r.indexedAt,
}))

// ── docs-db write behaviour, against a fresh database ───────────────────────
const dbPath = join(fixturesDir, 'owndocs.db')
removeOwnFixtureOrRefuse(dbPath, 'gen_owndocs_fixtures.mjs')
const db = new Database(dbPath)
markAsFixture(db, 'gen_owndocs_fixtures.mjs')
docsDbMod.ensureDocsSchema(db)

const writeCases = []
// 1. upsert the same source twice: label/baseUrl/language/indexedAt all move
docsDbMod.upsertSource(db, 'own_knowledge', 'first label', 'first/', 'zh-en', 'T1')
docsDbMod.upsertSource(db, 'own_knowledge', 'second label', 'second/', 'en', 'T2')
writeCases.push({ kind: 'sources-after-upsert', rows: db.query('SELECT * FROM bannerlord_docs_sources ORDER BY source').all() })

// 2. insert a handful of rows, then read both tables back
const sample = rows.slice(0, 5)
docsDbMod.insertDocRows(db, sample)
writeCases.push({ kind: 'pages-after-insert', rows: db.query('SELECT id, source, language, category, title, url, indexedAt FROM bannerlord_docs_pages ORDER BY id').all() })
writeCases.push({ kind: 'fts-count', count: db.query('SELECT COUNT(*) AS n FROM bannerlord_docs_fts').get().n })

// 3. ★ RE-INSERT THE SAME ROWS. The pages insert is OR REPLACE while the FTS insert is a plain
//    INSERT, so the page count stays while the FTS count GROWS. Pinned because it looks like a bug.
docsDbMod.insertDocRows(db, sample)
writeCases.push({ kind: 'pages-after-reinsert', count: db.query('SELECT COUNT(*) AS n FROM bannerlord_docs_pages').get().n })
writeCases.push({ kind: 'fts-after-reinsert', count: db.query('SELECT COUNT(*) AS n FROM bannerlord_docs_fts').get().n })

// 4. the FTS index is searchable, which is what the schema's prefix option exists for
const matchCount = db.query(`SELECT COUNT(*) AS n FROM bannerlord_docs_fts WHERE bannerlord_docs_fts MATCH '"body"*'`).get().n
writeCases.push({ kind: 'fts-prefix-match', count: matchCount })

// 5. delete by source, then both tables are empty of it
docsDbMod.deleteDocsBySource(db, 'own_knowledge')
writeCases.push({ kind: 'pages-after-delete', count: db.query('SELECT COUNT(*) AS n FROM bannerlord_docs_pages').get().n })
writeCases.push({ kind: 'fts-after-delete', count: db.query(`SELECT COUNT(*) AS n FROM bannerlord_docs_fts`).get().n })
writeCases.push({ kind: 'sources-after-delete', count: db.query('SELECT COUNT(*) AS n FROM bannerlord_docs_sources').get().n })

// 6. the schema objects that exist, for the Go side to compare against
writeCases.push({
  kind: 'schema',
  objects: db.query(`SELECT type, name FROM sqlite_master WHERE name LIKE 'bannerlord_docs%' ORDER BY type, name`).all(),
})
db.close()

const fixtures = {
  _comment:
    'GENERATED by gen_owndocs_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/docs-db.ts and own-docs.ts against the tree described by `shape` and against ' +
    'fixtures/owndocs.db. The Go test rebuilds the tree from `shape`: it contains a HIDDEN DIRECTORY ' +
    'and an EMPTY directory, which git cannot represent. Do not edit by hand.',
  shape: SHAPE,
  knowledgeRoot: 'tools/parity/fixtures/owndocs-tree/knowledge',
  extraDir: 'tools/parity/fixtures/owndocs-tree/extra',
  dbPath: 'tools/parity/fixtures/owndocs.db',
  pureCases,
  idCases,
  titleCases,
  walkCases,
  rowCases,
  writeCases,
}
writeFileSync(join(here, 'owndocs_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote owndocs_fixtures.json + fixtures/owndocs.db + fixtures/owndocs-tree/')
console.log('  pure cases  : ' + pureCases.length)
console.log('  title cases : ' + titleCases.length)
console.log('  walk cases  : ' + walkCases.length)
console.log('  row cases   : ' + rowCases.length)
console.log('  write cases : ' + writeCases.length)
console.log('')
console.log('  ★ a walk that includes the hidden entries?  files=' +
  JSON.stringify(walkCases.find(c => c.label === 'knowledge only').files))
console.log('  ★ re-insert: pages=' +
  writeCases.find(c => c.kind === 'pages-after-reinsert').count +
  ' fts=' + writeCases.find(c => c.kind === 'fts-after-reinsert').count +
  '   (OR REPLACE vs plain INSERT — the asymmetry is the original behaviour)')
