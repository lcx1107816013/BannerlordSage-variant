// Parity fixture generator for the BannerScribe Archive Go port.
//
// WHY THIS EXISTS
// ---------------
// The port's whole claim is "无损" (lossless). That claim is worth nothing unless
// it is measured. Unit tests written by the porter only prove the port matches
// the porter's own reading of the original — if the reading is wrong, the tests
// agree with the wrong reading and everything stays green.
//
// So the expected values here are produced by THE TYPESCRIPT ITSELF, and the Go
// tests compare against these frozen bytes. Two rules make that trustworthy:
//
//   1. The TS functions are taken from the real source files, not retyped.
//      - PathSandbox.validateAndResolve: imported from src/utils/path-sandbox.ts.
//      - buildFtsQuery: it is a module-private function (declared in both
//        src/tools/search-docs.ts and src/tools/search-api-docs.ts), so it is
//        EXTRACTED VERBATIM from its source text by name rather than copied by
//        hand. Extraction failures are fatal, so a rename upstream breaks this
//        loudly instead of silently producing a fixture that matches nothing.
//   2. Regenerating is deterministic. Same TS source in, same bytes out.
//
// Usage:  bun tools/parity/gen_fixtures.mjs
// Output: tools/parity/fixtures.json

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..') // server-go/tools/parity -> repo root
const gameSrc = join(repoRoot, 'src')

// ── 1. buildFtsQuery, extracted verbatim from real source ────────────────────
function extractFunction(sourceText, name, fileForErrors) {
    const start = sourceText.indexOf(`function ${name}(`)
    if (start === -1) throw new Error(`FATAL: function ${name} not found in ${fileForErrors}`)
    // Brace-match from the first '{' after the signature.
    const open = sourceText.indexOf('{', start)
    if (open === -1) throw new Error(`FATAL: no body for ${name} in ${fileForErrors}`)
    let depth = 0
    for (let i = open; i < sourceText.length; i++) {
        const c = sourceText[i]
        if (c === '{') depth++
        else if (c === '}') {
            depth--
            if (depth === 0) return sourceText.slice(start, i + 1)
        }
    }
    throw new Error(`FATAL: unbalanced braces extracting ${name} in ${fileForErrors}`)
}

// The extracted text is TypeScript (it has annotations like `query: string`), and
// `new Function` only accepts JavaScript — feeding it raw TS is a parse error.
// So the snippet is written to a temporary .ts file and imported properly, which
// lets the runtime transpile it. Hand-stripping annotations with a regex would be
// brittle; this path works for arbitrary TS syntax.
async function loadExtractedFunction(sourceText, name, fileForErrors, tmpDir) {
    const snippet = extractFunction(sourceText, name, fileForErrors)
    const tmpFile = join(tmpDir, `__extracted_${name}.mts`)
    writeFileSync(tmpFile, `export ${snippet}\n`, 'utf8')
    const mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
    const fn = mod[name]
    if (typeof fn !== 'function') throw new Error(`FATAL: extracted ${name} is not callable`)
    return fn
}

const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })

const searchDocsPath = join(gameSrc, 'tools', 'search-docs.ts')
const buildFtsQuery = await loadExtractedFunction(
    readFileSync(searchDocsPath, 'utf8'),
    'buildFtsQuery',
    searchDocsPath,
    tmpDir
)

// Cross-check: the same function is duplicated in search-api-docs.ts. If the two
// copies ever diverge, that is itself a finding, so assert they agree.
const searchApiDocsPath = join(gameSrc, 'tools', 'search-api-docs.ts')
const buildFtsQuery2 = await loadExtractedFunction(
    readFileSync(searchApiDocsPath, 'utf8'),
    'buildFtsQuery',
    searchApiDocsPath,
    tmpDir
)

// ── 2. PathSandbox, imported for real ───────────────────────────────────────
const { PathSandbox } = await import(
    // eslint-disable-next-line no-unsanitized/method
    'file:///' + join(gameSrc, 'utils', 'path-sandbox.ts').replace(/\\/g, '/')
)

// ── 3. Input corpora ────────────────────────────────────────────────────────
// Deliberately nasty: the F5 bug was a hyphenated query, and the sandbox gates
// were bypassed by cross-drive and UNC paths. The corpus targets those shapes.
const ftsInputs = [
    '',
    '   ',
    '"',
    '""',
    '" "',
    'gauntlet',
    'gauntlet ui',
    '  CalculateSpeed  ',
    'say "hello" now',
    '"quoted"',
    'a"b',
    'bannerscribe-regression-test', // F5 shape: a hyphen
    'foo-bar baz-qux',
    'multi   space\t\ttab',
    'tab\tsep',
    'new\nline',
    'AND',
    'OR NOT',
    'NEAR(a b)',
    '*wildcard*',
    'a AND b',
    'foo"AND"bar',
    'trailing"',
    '"leading',
    'ünïcödé tëxt',
    '中文 查询',
    '日本語',
    'emoji 🎯 test',
    'x'.repeat(200),
    'token1 token2 token3 token4 token5 token6 token7 token8 token9 token10',
    'a-b',
    '-leading-hyphen',
    'trailing-hyphen-',
    'a--b',
    'snake_case',
    'dot.separated',
    'slash/separated',
    'back\\slash',
    'paren(thesis)',
    'bracket[test]',
    'brace{test}',
    'caret^test',
    'tilde~test',
    'plus+test',
    'equals=test',
    'percent%test',
    'at@test',
    'hash#test',
    'dollar$test',
    'excl!test',
    'question?test',
    'colon:test',
    'semi;test',
    'comma,test',
    'quote\'test',
    'double"test',
    '<angle>test',
    'pipe|test',
    'amp&test',
]

const sandboxInputs = [
    '',
    '.',
    './',
    'Xmls/SkinData.xml',
    'Xmls\\SkinData.xml',
    'Xmls/../Xmls/a.xml',
    'Xmls\\..\\Xmls\\a.xml',
    'a/b/c.xml',
    'a',
    'a/b',
    '../outside.xml',
    '..\\outside.xml',
    '../../..',
    '..',
    '../..',
    'C:\\Windows\\win.ini',      // cross-drive absolute
    'C:/Windows/win.ini',       // cross-drive, forward slashes
    '\\\\server\\share\\x',     // UNC
    '//server/share/x',         // UNC forward slashes
    'D:\\repo\\dist\\games\\bannerlord\\assets\\x.xml',
    './a/./b.xml',
    'a//b.xml',
    'a\\\\b.xml',
    'sub/../../escape.xml',
    'sub\\..\\..\\escape.xml',
    'nested/deep/../../inside.xml',
    'space in name.xml',
    'ünicode/файл.xml',
    '中文/文件.xml',
    'CON',
    'NUL',
    'a/../../b',
    'valid.xml',
    'dir/valid.xml',
]

// ── 4. Generate ─────────────────────────────────────────────────────────────
const sandbox = new PathSandbox('D:\\repo\\dist\\games\\bannerlord\\assets')

const ftsCases = ftsInputs.map((input) => {
    const a = buildFtsQuery(input)
    const b = buildFtsQuery2(input)
    if (a !== b) {
        throw new Error(
            `FATAL: the two copies of buildFtsQuery disagree on ${JSON.stringify(input)}: ` +
                `${JSON.stringify(a)} vs ${JSON.stringify(b)}`
        )
    }
    return { input, want: a }
})

const sandboxCases = sandboxInputs.map((input) => {
    try {
        return { input, want: sandbox.validateAndResolve(input), wantError: null }
    } catch (error) {
        return { input, want: null, wantError: error.message }
    }
})

const fixtures = {
    _comment:
        'GENERATED by server-go/tools/parity/gen_fixtures.mjs from the TypeScript source. ' +
        'Do not edit by hand. Expected values come from the TS itself, so a Go test ' +
        'comparing against these bytes is a real equivalence check, not a self-consistent one.',
    basePath: sandbox.basePath,
    generatedFrom: {
        fts: 'src/tools/search-docs.ts :: buildFtsQuery (extracted verbatim, cross-checked against search-api-docs.ts)',
        sandbox: 'src/utils/path-sandbox.ts :: PathSandbox.validateAndResolve (imported)',
    },
    fts: ftsCases,
    sandbox: sandboxCases,
}

mkdirSync(here, { recursive: true })
const outPath = join(here, 'fixtures.json')
writeFileSync(outPath, JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

console.log(`wrote ${outPath}`)
console.log(`  fts     cases: ${ftsCases.length}`)
console.log(`  sandbox cases: ${sandboxCases.length}`)
console.log(
    `  sandbox rejections: ${sandboxCases.filter((c) => c.wantError !== null).length}`
)
console.log(`  sandbox basePath  : ${sandbox.basePath}`)
