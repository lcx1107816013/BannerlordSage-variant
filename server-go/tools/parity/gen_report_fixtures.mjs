// Parity fixture generator for the report renderer (src/utils/ai-text.ts).
//
// Same discipline as gen_fixtures.mjs: expected values come from EXECUTING the
// TypeScript, not from a human reading it. A hand-written expectation encodes the
// author's understanding; when that understanding is wrong the test agrees with the
// mistake (this project already lost time to exactly that — see ledger F12).
//
// The TypeScript is EXTRACTED VERBATIM from src/utils/ai-text.ts by name and
// imported, so a rename upstream breaks generation loudly instead of silently
// producing a fixture that matches nothing.
//
// Corpus focuses on the places a Go port actually diverges:
//   - boolean / number scalars, which the first Go version could not represent at
//     all (it took string only) and rendered as "unknown"
//   - "0" vs 0 vs "" — the empty-check is on the FORMATTED text, not the raw value
//   - Unicode whitespace: JS trim() and Go TrimSpace do not trim the same set
//   - embedded CRLF vs LF vs lone CR in multiline fields
//   - empty lists, empty blocks, and the trailing-blank-line rule between blocks
//
// Usage: bun run server-go/tools/parity/gen_report_fixtures.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const aiTextPath = join(repoRoot, 'src', 'utils', 'ai-text.ts')

function extractFunction(sourceText, name, fileForErrors) {
    const start = sourceText.indexOf(`export function ${name}(`)
    if (start === -1) throw new Error(`FATAL: export function ${name} not found in ${fileForErrors}`)
    const open = sourceText.indexOf('{', start)
    if (open === -1) throw new Error(`FATAL: no body for ${name}`)
    let depth = 0
    for (let i = open; i < sourceText.length; i++) {
        if (sourceText[i] === '{') depth++
        else if (sourceText[i] === '}') {
            depth--
            if (depth === 0) return sourceText.slice(start, i + 1)
        }
    }
    throw new Error(`FATAL: unbalanced braces extracting ${name}`)
}

const tmpDir = join(here, '.tmp')
mkdirSync(tmpDir, { recursive: true })

// Both functions must be emitted together: renderAiTextReport CALLS formatAiScalar,
// so extracting only the renderer produces a module that throws
// "formatAiScalar is not defined" for any non-empty field. The first version of
// this generator made exactly that mistake and silently skipped most render cases.
async function loadExtractedFunctions(sourceText, names, fileForErrors) {
    const snippets = names.map((n) => extractFunction(sourceText, n, fileForErrors))
    const tmpFile = join(tmpDir, '__r_combined.mts')
    writeFileSync(tmpFile, snippets.join('\n\n') + '\n', 'utf8')
    const mod = await import('file:///' + tmpFile.replace(/\\/g, '/'))
    const out = {}
    for (const n of names) {
        if (typeof mod[n] !== 'function') throw new Error(`FATAL: ${n} not callable`)
        out[n] = mod[n]
    }
    return out
}

const src = readFileSync(aiTextPath, 'utf8')
const { formatAiScalar, renderAiTextReport } = await loadExtractedFunctions(
    src,
    ['formatAiScalar', 'renderAiTextReport'],
    aiTextPath
)

// ── scalars ────────────────────────────────────────────────────────────────
// Each entry is tagged so the Go side can build the same value; JSON cannot carry
// `undefined` or NaN, so the tag is what makes them round-trippable.
const scalarCases = [
    { tag: 'undefined', value: undefined },
    { tag: 'null', value: null },
    { tag: 'string', value: '' },
    { tag: 'string', value: '   ' },
    { tag: 'string', value: '\t\n ' },
    { tag: 'string', value: 'x' },
    { tag: 'string', value: '  spaced  ' },
    { tag: 'string', value: '0' },
    { tag: 'string', value: 'false' },
    { tag: 'string', value: 'unknown' },
    { tag: 'string', value: '\u00a0' },              // non-breaking space
    { tag: 'string', value: '\u2003' },              // em space
    { tag: 'string', value: '\ufeff' },              // BOM / zero-width no-break
    { tag: 'string', value: '\u00a0x\u00a0' },
    { tag: 'number', value: 0 },
    { tag: 'number', value: -0 },
    { tag: 'number', value: 1 },
    { tag: 'number', value: -1 },
    { tag: 'number', value: 3.14 },
    { tag: 'number', value: -2.5 },
    { tag: 'number', value: 1e21 },
    { tag: 'number', value: NaN },
    { tag: 'number', value: Infinity },
    { tag: 'number', value: -Infinity },
    // ── exponent boundaries, where JS and Go disagree by default ──
    // JS uses exponential notation only for |x| >= 1e21 or |x| < 1e-6, and writes
    // the exponent WITHOUT zero padding ("1e-7"). Go's 'g' switches at 1e-5 and pads
    // ("1e-07"). Both differences are pinned here so the port must handle them.
    { tag: 'number', value: 1e-5 },
    { tag: 'number', value: 0.00001 },
    { tag: 'number', value: 1e-6 },
    { tag: 'number', value: 1e-7 },
    { tag: 'number', value: 1.5e-7 },
    { tag: 'number', value: 1e20 },
    { tag: 'number', value: 100 },
    { tag: 'number', value: 0.1 },
    { tag: 'number', value: 0.3 },
    { tag: 'number', value: 1 / 3 },
    { tag: 'number', value: 12345678901234567890 },
    { tag: 'number', value: 5e-324 },
    { tag: 'number', value: 1.7976931348623157e308 },
    { tag: 'boolean', value: true },
    { tag: 'boolean', value: false },
    { tag: 'string', value: '中文' },
    { tag: 'string', value: 'line1\nline2' },
]

// ── render cases ───────────────────────────────────────────────────────────
const S = (v) => ({ tag: 'string', value: v })
const N = (v) => ({ tag: 'number', value: v })
const B = (v) => ({ tag: 'boolean', value: v })
const NL = { tag: 'null', value: null }
const UD = { tag: 'undefined', value: undefined }

const renderCases = [
    {
        name: 'no blocks',
        reportType: 'xml_search', queryKey: 'query_text', queryValue: 'q',
        blocks: [], topFields: [],
    },
    {
        name: 'no blocks, one top field',
        reportType: 'xml_search', queryKey: 'query_text', queryValue: 'q',
        blocks: [], topFields: [{ key: 'fts_query', value: S('"q"*') }],
    },
    {
        name: 'top fields of every scalar kind',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [],
        topFields: [
            { key: 'str', value: S('a') },
            { key: 'num0', value: N(0) },
            { key: 'num', value: N(42) },
            { key: 'bool_true', value: B(true) },
            { key: 'bool_false', value: B(false) },
            { key: 'null', value: NL },
            { key: 'undef', value: UD },
            { key: 'blank', value: S('   ') },
            { key: 'nan', value: N(NaN) },
        ],
    },
    {
        name: 'single block, all field kinds',
        reportType: 'xml_search', queryKey: 'query_text', queryValue: 'gauntlet ui',
        blocks: [{
            header: 'match_1',
            fields: [{ key: 'module_name', value: S('Native') }, { key: 'file', value: N(7) }],
            listFields: [{ key: 'tags', values: [S('a'), S(''), N(0), B(false), NL] }],
            multilineFields: [{ key: 'snippet', value: S('line1\nline2') }],
        }],
        topFields: [{ key: 'fts_query', value: S('"gauntlet"*') }],
    },
    {
        name: 'empty list renders - none',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [{ listFields: [{ key: 'empty', values: [] }] }],
        topFields: [],
    },
    {
        name: 'block with no header omits result_label',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [{ fields: [{ key: 'a', value: S('1') }] }],
        topFields: [],
    },
    {
        name: 'blank header string is falsy so label omitted',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [{ header: '', fields: [{ key: 'a', value: S('1') }] }],
        topFields: [],
    },
    {
        name: 'multiline: CRLF, LF, lone CR, blank, trailing newline',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [{
            multilineFields: [
                { key: 'crlf', value: S('a\r\nb') },
                { key: 'lf', value: S('a\nb') },
                { key: 'cr', value: S('a\rb') },
                { key: 'blank', value: S('   ') },
                { key: 'empty', value: S('') },
                { key: 'null', value: NL },
                { key: 'undef', value: UD },
                { key: 'trailing', value: S('a\n') },
                { key: 'leading', value: S('\na') },
                { key: 'crlf_then_blank', value: S('a\r\n\r\nb') },
            ],
        }],
        topFields: [],
    },
    {
        name: 'three blocks: blank line BETWEEN, not after the last',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [
            { header: 'b1', fields: [{ key: 'x', value: S('1') }] },
            { header: 'b2', fields: [{ key: 'x', value: S('2') }] },
            { header: 'b3', fields: [{ key: 'x', value: S('3') }] },
        ],
        topFields: [],
    },
    {
        name: 'empty block object',
        reportType: 't', queryKey: 'k', queryValue: 'v',
        blocks: [{}],
        topFields: [],
    },
    {
        name: 'query value and key with odd content',
        reportType: 'r:type', queryKey: 'k:ey', queryValue: 'a: b\nc',
        blocks: [],
        topFields: [],
    },
    {
        name: 'unicode content',
        reportType: 't', queryKey: 'k', queryValue: '查询',
        blocks: [{ header: '结果_1', fields: [{ key: '名称', value: S('中文值') }] }],
        topFields: [],
    },
]

// ── corpus decoding ────────────────────────────────────────────────────────
//
// The corpus is written with TAGGED scalars ({tag, value}) because JSON cannot carry
// `undefined`, NaN or Infinity, and the Go side needs to rebuild the same inputs.
//
// But the TypeScript must receive REAL values, so every tagged scalar is decoded
// before the call. The first version passed the tagged objects straight through:
//   - formatAiScalar did String({tag:'number',value:42}) -> "[object Object]", so ten
//     "expected" values were garbage the port could never legitimately match, and
//   - the multiline loop threw "field.value?.trim is not a function", because an
//     object has no .trim.
// A fixture whose expected value is nonsense is worse than no fixture: it looks like
// coverage. The decode step below is the fix, and it is the only place that needed one.
function decodeScalar(tagged) {
    if (!tagged || typeof tagged !== 'object') return tagged
    switch (tagged.tag) {
        case 'undefined': return undefined
        case 'null': return null
        case 'boolean': return Boolean(tagged.value)
        case 'number':
            if (tagged.value === 'NaN') return NaN
            if (tagged.value === 'Infinity') return Infinity
            if (tagged.value === '-Infinity') return -Infinity
            return Number(tagged.value)
        case 'string': return String(tagged.value)
        default: throw new Error(`FATAL: unknown scalar tag ${tagged.tag}`)
    }
}

const decodeFields = (fields) => (fields ?? []).map((f) => ({ key: f.key, value: decodeScalar(f.value) }))
const decodeListFields = (lfs) =>
    (lfs ?? []).map((lf) => ({ key: lf.key, values: (lf.values ?? []).map(decodeScalar) }))
const decodeBlock = (b) => ({
    ...(b.header === undefined ? {} : { header: b.header }),
    ...(b.fields === undefined ? {} : { fields: decodeFields(b.fields) }),
    ...(b.listFields === undefined ? {} : { listFields: decodeListFields(b.listFields) }),
    ...(b.multilineFields === undefined ? {} : { multilineFields: decodeFields(b.multilineFields) }),
})

const scalarOut = scalarCases.map((c) => {
    let out
    try {
        out = { ok: true, result: formatAiScalar(decodeScalar(c)) }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    // `value` is echoed back so the Go side can rebuild the SAME input. Without it
    // the port would be tested against empty/default values while the report still
    // said "compared N cases" — a suite that passes without testing anything.
    const echoed =
        c.tag === 'undefined' ? null
            : Number.isNaN(c.value) ? 'NaN'
                : c.value === Infinity ? 'Infinity'
                    : c.value === -Infinity ? '-Infinity'
                        : c.value
    return { tag: c.tag, value: echoed, ...out }
})

// `inputs` carries every render input verbatim (tagged, for JSON) so the Go test can
// replay them. `result` is the TypeScript's output for the DECODED equivalents.
const renderOut = renderCases.map((c) => {
    let out
    try {
        const result = renderAiTextReport(
            c.reportType, c.queryKey, c.queryValue,
            c.blocks.map(decodeBlock), decodeFields(c.topFields)
        )
        out = { ok: true, result }
    } catch (error) {
        out = { ok: false, error: String(error && error.message) }
    }
    return {
        name: c.name,
        inputs: {
            reportType: c.reportType,
            queryKey: c.queryKey,
            queryValue: c.queryValue,
            blocks: c.blocks,
            topFields: c.topFields,
        },
        ...out,
    }
})

const fixtures = {
    _comment:
        'GENERATED by server-go/tools/parity/gen_report_fixtures.mjs from src/utils/ai-text.ts. ' +
        'Do not edit by hand. Values are produced by EXECUTING the TypeScript.',
    generatedFrom: 'src/utils/ai-text.ts :: renderAiTextReport + formatAiScalar (extracted verbatim)',
    scalars: scalarOut,
    renders: renderOut,
}

// JSON.stringify cannot represent NaN or the infinities — it silently writes them
// as `null`. That is how the render corpus lost its NaN: the scalar corpus spells
// the sentinel explicitly, but `inputs` is written straight from the corpus, so
// NaN became null, the Go decoder read 0, and the suite reported
// `nan: 0` versus `nan: NaN` — a harness defect wearing the costume of a port defect.
//
// A replacer sees the value BEFORE serialisation, so one is used to map every
// non-finite number onto the same sentinel strings the scalar corpus uses. Applying
// it to the whole document means no future field can silently lose a NaN again.
function nonFiniteReplacer(_key, value) {
    if (typeof value !== 'number' || Number.isFinite(value)) return value
    if (Number.isNaN(value)) return 'NaN'
    return value > 0 ? 'Infinity' : '-Infinity'
}

writeFileSync(join(here, 'report_fixtures.json'),
    JSON.stringify(fixtures, nonFiniteReplacer, 2) + '\n', 'utf8')
console.log(`wrote report_fixtures.json`)
console.log(`  scalar cases: ${scalarOut.length}`)
console.log(`  render cases: ${renderOut.length}`)
console.log()
console.log('scalar results the Go port must reproduce:')
for (const s of scalarOut) {
    console.log(`  ${String(s.tag).padEnd(10)} ${JSON.stringify(s.value).padEnd(12)} -> ${s.ok ? JSON.stringify(s.result) : 'THREW ' + s.error}`)
}
