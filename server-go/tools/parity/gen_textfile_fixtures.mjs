// Parity fixture generator for src/utils/text-file-cache.ts.
//
// The unit is IO-bound but its behaviour is deterministic, so this uses the "many inputs"
// technique rather than the store fixture's database technique: it writes a set of small
// files with deliberately awkward shapes, then records what the TypeScript returns for
// every (file, startLine, lineCount) combination that can expose a clamping or splitting
// edge.
//
// Cases chosen because they are where a port diverges:
//   - startLine negative              -> clamped to 0
//   - lineCount 0 and negative        -> clamped to 1 (a 0-line request still returns 1)
//   - startLine beyond EOF            -> empty text, startLine reported unclamped
//   - a slice exactly at EOF          -> hasMore false
//   - a slice one line short of EOF   -> hasMore true
//   - empty file                      -> 1 line, and the single line is ""
//   - file with no trailing newline   -> no phantom final empty line
//   - file WITH trailing newline      -> phantom final empty line (split semantics)
//   - CRLF file                       -> split on \r?\n, so no stray \r
//   - lone CR                         -> NOT a separator
//   - file whose last line is whitespace
//
// Usage: bun run server-go/tools/parity/gen_textfile_fixtures.mjs

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const mod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'text-file-cache.ts')).href)
const { readTextFileSlice, readTextFileLines, clearTextFileCache } = mod

const dir = join(here, 'fixtures', 'textfiles')
if (existsSync(dir)) rmSync(dir, { recursive: true })
mkdirSync(dir, { recursive: true })

// ── the corpus files ────────────────────────────────────────────────────────
const files = {
    'five-lines.txt': 'l0\nl1\nl2\nl3\nl4',              // no trailing newline: 5 lines
    'five-lines-trailing.txt': 'l0\nl1\nl2\nl3\nl4\n',   // trailing newline: 6 lines, last is ""
    'empty.txt': '',
    'one-line.txt': 'only',
    'crlf.txt': 'a\r\nb\r\nc',
    'crlf-trailing.txt': 'a\r\nb\r\nc\r\n',
    'lone-cr.txt': 'a\rb',                                // \r is NOT a separator
    'blank-lines.txt': '\n\n\n',                          // 4 empty lines
    'whitespace-last.txt': 'a\n   ',                      // last line is spaces
    'unicode.txt': '中文一\n中文二\nemoji 🎯',
    'no-final-newline-long.txt': Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n'),
}

for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8')
}

// ── the probes ──────────────────────────────────────────────────────────────
// startLine/lineCount pairs chosen to hit every clamp and boundary on a 5-line file and a
// 12-line file.
const sliceSpecs = [
    [0, 400],
    [0, 0],
    [0, -1],
    [0, 1],
    [0, 5],
    [0, 6],
    [0, 100],
    [-1, 2],
    [-100, 3],
    [1, 2],
    [4, 1],
    [4, 2],
    [5, 1],
    [5, 100],
    [6, 1],
    [100, 1],
    [100, 0],
    [2, 400],
    [2, 1_000_000],
    [-5, -5],
]

const sliceResults = []
for (const [name, content] of Object.entries(files)) {
    const full = join(dir, name)
    for (const [startLine, lineCount] of sliceSpecs) {
        clearTextFileCache()
        let out
        try {
            out = { ok: true, slice: await readTextFileSlice(full, startLine, lineCount) }
        } catch (error) {
            out = { ok: false, error: String(error && error.message) }
        }
        sliceResults.push({ file: name, startLine, lineCount, ...out })
    }
}

// readTextFileLines: the raw line split, per file. This is where the split semantics are
// recorded most directly.
const lineResults = []
for (const name of Object.keys(files)) {
    clearTextFileCache()
    let out
    try {
        out = { ok: true, lines: await readTextFileLines(join(dir, name)) }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    lineResults.push({ file: name, ...out })
}

// Missing file: the TypeScript rejects, and the port must too rather than returning an
// empty slice.
clearTextFileCache()
let missingOut
try {
    await readTextFileSlice(join(dir, 'does-not-exist.txt'), 0, 10)
    missingOut = { ok: true, note: 'UNEXPECTED: resolved' }
} catch (error) {
    missingOut = { ok: false, error: String(error && error.message) }
}

// LRU: read 9 files, then re-read the FIRST one and confirm it still resolves correctly.
// The TypeScript evicts the oldest beyond 8, so the first is no longer cached; the
// observable answer must be IDENTICAL either way. This pins that eviction changes
// performance, never results.
clearTextFileCache()
const lruOrder = Object.keys(files).concat(['five-lines.txt', 'one-line.txt', 'empty.txt'])
const lruResults = []
for (const name of lruOrder) {
    const s = await readTextFileSlice(join(dir, name), 0, 2)
    lruResults.push({ file: name, text: s.text, totalLines: s.totalLines })
}

const fixtures = {
    _comment:
        'GENERATED by gen_textfile_fixtures.mjs. Expected values come from EXECUTING ' +
        'src/utils/text-file-cache.ts against fixtures/textfiles. Do not edit by hand.',
    generatedFrom: 'src/utils/text-file-cache.ts (imported)',
    fileContents: files,
    slices: sliceResults,
    lines: lineResults,
    missingFile: missingOut,
    lru: lruResults,
}

writeFileSync(join(here, 'textfile_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

const okSlices = sliceResults.filter((s) => s.ok).length
console.log('wrote textfile_fixtures.json + fixtures/textfiles/')
console.log(`  files       : ${Object.keys(files).length}`)
console.log(`  slice probes: ${sliceResults.length} (${okSlices} resolved)`)
console.log(`  line probes : ${lineResults.length}`)
console.log()
const show = (name) => {
    const f = lineResults.find((x) => x.file === name)
    console.log(`  ${name.padEnd(24)} -> ${f.ok ? JSON.stringify(f.lines) : 'THREW ' + f.error}`)
}
console.log('  line splits (the split semantics, recorded directly):')
for (const n of ['five-lines.txt', 'five-lines-trailing.txt', 'empty.txt', 'crlf.txt', 'lone-cr.txt', 'blank-lines.txt']) show(n)
console.log()
console.log('  clamping highlights:')
for (const s of sliceResults) {
    if (s.file !== 'five-lines.txt') continue
    if (!s.ok) continue
    console.log(`      start=${String(s.startLine).padStart(5)} count=${String(s.lineCount).padStart(7)} -> end=${s.endLineExclusive} total=${s.totalLines} hasMore=${s.hasMore} text=${JSON.stringify(s.slice.text)}`)
}
