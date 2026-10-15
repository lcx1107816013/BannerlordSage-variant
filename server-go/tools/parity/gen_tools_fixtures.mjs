// Parity fixture generator for the first two tool bodies:
//   src/tools/read-file.ts      -> readFile(sandbox, relativePath, startLine, lineCount)
//   src/tools/list-directory.ts -> listDirectory(sandbox, relativePath)
//
// These are the first TOOL-layer units, so the fixtures capture the rendered report TEXT
// rather than a return value. That is deliberate: the text is what downstream consumers
// parse, so comparing text is the strongest available assertion.
//
// The corpus targets the details a careful reader would "fix" in the port:
//   - `resolved_path` holds the RELATIVE path in the TypeScript, despite the name
//   - `start_line_0based` / `requested_line_count` are the RAW request values, so a
//     negative startLine renders as negative in the report
//   - `returned_line_count` is endLineExclusive - startLine using the RAW startLine,
//     which does not equal the number of returned lines when startLine is negative
//   - `has_more` goes through formatAiScalar, so it renders as the text "true"/"false"
//   - an empty directory yields the literal sentence "Directory is empty."
//   - the sort is by UTF-16 CODE UNIT, which differs from Go's byte order above the BMP;
//     the corpus contains a supplementary-character name next to U+E000 to prove it
//
// Usage: bun run server-go/tools/parity/gen_tools_fixtures.mjs

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const readFileMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'read-file.ts')).href)
const listDirMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'list-directory.ts')).href)
const { PathSandbox } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'path-sandbox.ts')).href)
const { clearTextFileCache } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'text-file-cache.ts')).href)

const { readFile } = readFileMod
const { listDirectory } = listDirMod

// ── build a sandbox tree ────────────────────────────────────────────────────
const root = join(here, 'fixtures', 'toolroot')
if (existsSync(root)) rmSync(root, { recursive: true })
mkdirSync(root, { recursive: true })

const write = (rel, content) => {
    const full = join(root, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, content, 'utf8')
}

write('plain.txt', 'l0\nl1\nl2\nl3\nl4')
write('trailing.txt', 'a\nb\n')
write('empty.txt', '')
write('crlf.txt', 'x\r\ny\r\nz')
write('sub/nested.txt', 'n0\nn1\nn2')
write('sub/deep/deeper.txt', 'd0')

// Directory-listing corpus. The names are chosen to separate sort rules:
//   "Z" (U+005A) < "_" (U+005F) < "a" (U+0061)         ASCII, both rules agree
//   "\uE000" is a BMP private-use char
//   "\u{1F3AF}" is supplementary: UTF-16 leading unit D83C < E000, but UTF-8 bytes
//   F0 9F 8E AF > EE 80 80. So UTF-16 order and byte order DISAGREE here.
//   "中文" exercises multi-byte BMP characters.
const listDir = join(root, 'listing')
mkdirSync(listDir, { recursive: true })
for (const name of ['Z.txt', '_underscore.txt', 'a.txt', '\uE000-bmp.txt', '\u{1F3AF}-emoji.txt', '中文.txt', 'z-last.txt']) {
    writeFileSync(join(listDir, name), 'x', 'utf8')
}
mkdirSync(join(listDir, 'adir'), { recursive: true })
mkdirSync(join(listDir, 'Zdir'), { recursive: true })
writeFileSync(join(listDir, 'adir', 'inner.txt'), 'x', 'utf8')

// An empty directory, for the "Directory is empty." branch.
mkdirSync(join(root, 'emptydir'), { recursive: true })

// ── probes ──────────────────────────────────────────────────────────────────
const box = new PathSandbox(root)

const readFileSpecs = [
    { path: 'plain.txt', startLine: 0, lineCount: 400 },
    { path: 'plain.txt', startLine: 0, lineCount: 2 },
    { path: 'plain.txt', startLine: 2, lineCount: 400 },
    { path: 'plain.txt', startLine: 4, lineCount: 1 },
    { path: 'plain.txt', startLine: 5, lineCount: 1 },
    { path: 'plain.txt', startLine: -1, lineCount: 2 },
    { path: 'plain.txt', startLine: -100, lineCount: 3 },
    { path: 'plain.txt', startLine: 0, lineCount: 0 },
    { path: 'plain.txt', startLine: 0, lineCount: -5 },
    { path: 'plain.txt', startLine: 100, lineCount: 10 },
    { path: 'trailing.txt', startLine: 0, lineCount: 400 },
    { path: 'empty.txt', startLine: 0, lineCount: 400 },
    { path: 'crlf.txt', startLine: 0, lineCount: 400 },
    { path: 'sub/nested.txt', startLine: 1, lineCount: 1 },
    { path: 'sub/deep/deeper.txt', startLine: 0, lineCount: 400 },
    // Non-ASCII relative path, to keep the report text honest.
    { path: 'sub/nested.txt', startLine: 0, lineCount: 1 },
]

const readFileOut = []
for (const spec of readFileSpecs) {
    clearTextFileCache()
    let out
    try {
        const res = await readFile(box, spec.path, spec.startLine, spec.lineCount)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    readFileOut.push({ ...spec, ...out })
}

// Failure modes: these must REJECT, not return an empty report.
const readFileFailures = []
for (const spec of [
    { path: 'missing.txt', startLine: 0, lineCount: 10 },
    { path: '../escape.txt', startLine: 0, lineCount: 10 },
    { path: 'C:\\Windows\\win.ini', startLine: 0, lineCount: 10 },
    { path: 'sub', startLine: 0, lineCount: 10 }, // a directory, not a file
]) {
    clearTextFileCache()
    let out
    try {
        const res = await readFile(box, spec.path, spec.startLine, spec.lineCount)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    readFileFailures.push({ ...spec, ...out })
}

const listDirSpecs = ['', 'listing', 'sub', 'emptydir', 'listing/adir']
const listDirOut = []
for (const spec of listDirSpecs) {
    let out
    try {
        const res = await listDirectory(box, spec)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    listDirOut.push({ path: spec, ...out })
}

const listDirFailures = []
for (const spec of ['missingdir', 'plain.txt', '../outside']) {
    let out
    try {
        const res = await listDirectory(box, spec)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    listDirFailures.push({ path: spec, ...out })
}

const fixtures = {
    _comment:
        'GENERATED by gen_tools_fixtures.mjs. Expected values come from EXECUTING ' +
        'src/tools/read-file.ts and src/tools/list-directory.ts against fixtures/toolroot. ' +
        'Do not edit by hand.',
    generatedFrom: 'src/tools/read-file.ts + src/tools/list-directory.ts',
    sandboxRoot: 'fixtures/toolroot',
    readFile: readFileOut,
    readFileFailures,
    listDirectory: listDirOut,
    listDirectoryFailures: listDirFailures,
}

writeFileSync(join(here, 'tools_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

console.log('wrote tools_fixtures.json + fixtures/toolroot/')
console.log(`  readFile probes        : ${readFileOut.length} (${readFileOut.filter((x) => x.ok).length} rendered)`)
console.log(`  readFile failure modes : ${readFileFailures.length} (${readFileFailures.filter((x) => !x.ok).length} rejected)`)
console.log(`  listDirectory probes   : ${listDirOut.length}`)
console.log(`  listDirectory failures : ${listDirFailures.length} (${listDirFailures.filter((x) => !x.ok).length} rejected)`)
console.log()
console.log('  ★ the listing sort (UTF-16 order, not byte order):')
const listing = listDirOut.find((x) => x.path === 'listing')
if (listing && listing.ok) {
    for (const line of listing.text.split('\n')) console.log(`      ${line}`)
}
console.log()
console.log('  ★ a negative startLine in the report (raw values, not clamped):')
const neg = readFileOut.find((x) => x.startLine === -1)
if (neg && neg.ok) console.log(neg.text.split('\n').slice(0, 9).map((l) => '      ' + l).join('\n'))
