// Independent differential: run the FROZEN baseline (8311c9a, exported to
// _workutils/base) and the rewritten tree side by side over one corpus, and
// compare every returned value byte for byte.
//
// Why this exists on top of the fixture suite: the fixtures are strong where a
// generator reaches a function. This harness covers the exported surface those
// generators never touch (mod-source workspace resolution, the local-mod alias
// layer, api-version parsing), so "no fixture covers it" cannot hide a change.
//
// Usage: bun run tools/rewrite-verify/diff_utils_units.mjs

import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const NEW_ROOT = 'D:/GitHub/BannerlordSage-variant'
const OLD_ROOT = 'D:/Documents/_workutils/base'
const u = p => pathToFileURL(p).href
const U = (root, name) => u(join(root, 'src', 'utils', name))

const problems = []
let compared = 0

// ★ PIN THE GAME ID FIRST. Several units resolve a database under
// dist/games/<activeGame>/, and opening a bun:sqlite handle CREATES the file when
// it is missing. Pointing that at the real `bannerlord` id would let a read-only
// differential write into the real data path (this project already lost the real
// compile index exactly that way - see the parity README, F19). A fixture-only id
// cannot collide with anything real.
const FIXTURE_GAME_ID = 'blore-diff-fixture-no-such-game'
process.env.BANNERSAGE_GAME = FIXTURE_GAME_ID
delete process.env.BANNERLORDSAGE_GAME

// Several results are absolute paths derived from the module's OWN file
// location, so the two checkouts legitimately disagree on the prefix. Each
// side's repo root is therefore folded to <ROOT> before comparison - the
// RELATIVE layout is the contract being checked, not where the tree lives.
// Both roots are folded on both sides because `resolve()` also folds in the
// process CWD, which is the new checkout for either side.
const ROOT_SPELLINGS = [OLD_ROOT, NEW_ROOT].flatMap(root => [root, root.replaceAll('/', '\\')])

function normalize(_side, value) {
    const walk = node => {
        if (typeof node === 'string') {
            let out = node
            for (const spelling of ROOT_SPELLINGS) out = out.replaceAll(spelling, '<ROOT>')
            return out
        }
        if (Array.isArray(node)) return node.map(walk)
        if (node && typeof node === 'object') {
            const out = {}
            for (const [k, v] of Object.entries(node)) out[k] = walk(v)
            return out
        }
        return node
    }
    return walk(value)
}

// JSON.stringify cannot carry `undefined` through an object key, and the two
// sides must agree on "absent" as much as on a value, so undefined is spelled
// explicitly before serialisation. `null` and `undefined` are deliberately
// spelled DIFFERENTLY, because telling them apart is part of the contract.
function encode(value) {
    return JSON.stringify(value, (_key, v) => (v === undefined ? '<undefined>' : v))
}

function record(label, a, b) {
    compared += 1
    if (encode(a) !== encode(b)) {
        problems.push(`${label}\n    old = ${encode(a)}\n    new = ${encode(b)}`)
    }
}

async function run(label, fn) {
    let a, b
    try { a = normalize('old', await fn('old')) } catch (e) { a = thrown(e) }
    try { b = normalize('new', await fn('new')) } catch (e) { b = thrown(e) }
    record(label, a, b)
}

// A thrown error is part of the observable contract, but its MESSAGE is not
// always: bun embeds the offending SOURCE TEXT in a TypeError, and the whole
// point of this exercise is that the source text differs. So the comparison
// keeps the constructor name and the message up to the embedded source, and
// folds the source itself to <SOURCE>.
function thrown(error) {
    const name = error?.constructor?.name ?? 'Error'
    const message = String(error?.message ?? error)
    return `${name}: ${message.split(" (In '")[0]}`
}

const mods = {}
for (const name of ['ai-text', 'env', 'mod-source', 'local-mod-source', 'bannerlord-api-docs', 'runtime-revision', 'bannerlord-entity-resolver']) {
    mods[name] = {
        old: await import(U(OLD_ROOT, name + '.ts')),
        new: await import(U(NEW_ROOT, name + '.ts')),
    }
}

// ── ai-text ─────────────────────────────────────────────────────────────────
const scalars = [undefined, null, '', '   ', 'x', '  y  ', '0', '\u00a0', '\ufeff', 0, -0, 1, -2.5,
    1e21, 1e-7, NaN, Infinity, -Infinity, true, false, '中文', 12345678901234567890]
for (const value of scalars) {
    await run(`formatAiScalar(${JSON.stringify(String(value))})`,
        side => mods['ai-text'][side].formatAiScalar(value))
    await run(`formatAiScalar(${JSON.stringify(String(value))}, '-')`,
        side => mods['ai-text'][side].formatAiScalar(value, '-'))
}
async function renderCase(side, blocks, topFields = []) {
    return mods['ai-text'][side].renderAiTextReport('t', 'k', 'v', blocks, topFields)
}
const renderCorpus = [
    { label: 'no blocks', blocks: [], topFields: [] },
    {
        label: 'blank header is falsy so the label is omitted',
        blocks: [{ header: '', fields: [{ key: 'a', value: 1 }] }],
        topFields: [],
    },
    { label: 'empty list renders - none', blocks: [{ listFields: [{ key: 'l', values: [] }] }], topFields: [] },
    {
        label: 'multiline: CRLF, LF and a lone CR',
        blocks: [{ multilineFields: [{ key: 'm', value: 'a\r\nb\nc\rd' }] }],
        topFields: [],
    },
    {
        label: 'multiline: empty string and null both become unknown',
        blocks: [{ multilineFields: [{ key: 'm', value: '' }, { key: 'n', value: null }] }],
        topFields: [],
    },
    {
        // ★ Whitespace-only is the case that tells "test the TRIMMED text" apart
        // from "test the raw value": '' is falsy both ways, '   ' is only falsy
        // after trimming. Without this entry a mutation of that condition
        // survives the whole corpus.
        label: 'multiline: whitespace-only trims to nothing',
        blocks: [{
            multilineFields: [
                { key: 'spaces', value: '   ' },
                { key: 'tabs', value: '\t\n ' },
                { key: 'nbsp', value: '\u00a0' },
                { key: 'bom', value: '\ufeff' },
                { key: 'newlines', value: '\n\n' },
                { key: 'cr', value: '\r' },
            ],
        }],
        topFields: [],
    },
    { label: 'header with one top field', blocks: [{ header: 'h' }], topFields: [{ key: 'top', value: 'x' }] },
    {
        label: 'three blocks: blank line BETWEEN, not after the last',
        blocks: [
            { fields: [{ key: 'a', value: 1 }] },
            { fields: [{ key: 'b', value: 2 }] },
            { listFields: [{ key: 'l', values: ['x', null, false] }] },
        ],
        topFields: [],
    },
    {
        label: 'every scalar kind in one block',
        blocks: [{
            header: 'all',
            fields: [
                { key: 'str', value: 'a' },
                { key: 'num0', value: 0 },
                { key: 'bool', value: true },
                { key: 'nul', value: null },
                { key: 'undef', value: undefined },
                { key: 'blank', value: '   ' },
                { key: 'nan', value: NaN },
            ],
            multilineFields: [{ key: 'code', value: 'l1\nl2' }],
        }],
        topFields: [{ key: 'fts', value: '"q"*' }],
    },
    { label: 'empty block object', blocks: [{}], topFields: [] },
]
for (const entry of renderCorpus) {
    await run(`renderAiTextReport(${entry.label})`,
        side => renderCase(side, entry.blocks, entry.topFields))
}

// A non-array third argument is a real call-site mistake, so the failure mode is
// part of the contract even though the thrown message embeds source text.
await run('renderAiTextReport(blocks = undefined)', side => renderCase(side, undefined, []))

// ── env ─────────────────────────────────────────────────────────────────────
const ids = [undefined, '', '   ', 'BANNERLORD', '  BANNERLORD  ', 'bannerlord', 'Other Game',
    '\ufeffX', 'İSTANBUL', '中文游戏']
for (const id of ids) {
    await run(`normalizeGameId(${JSON.stringify(id)})`, side => mods['env'][side].normalizeGameId(id))
    await run(`getGamePaths(${JSON.stringify(id)})`, side => mods['env'][side].getGamePaths(id))
}
await run('getGamePaths()', side => mods['env'][side].getGamePaths())
await run('activeGameId', side => mods['env'][side].activeGameId)
await run('DEFAULT_GAME_ID', side => mods['env'][side].DEFAULT_GAME_ID)

// ★ THE ENV-KEY PRECEDENCE. `activeGameId` is frozen at import, so it cannot
// answer "which spelling wins" - that decision lives in getActiveGameId(), which
// reads the environment on every call. Both spellings are set to DIFFERENT values
// here, because setting only one of them makes the order unobservable.
const ENV_KEY_COMBOS = [
    {},
    { BANNERSAGE_GAME: 'from-bannersage' },
    { BANNERLORDSAGE_GAME: 'from-bannerlord' },
    { BANNERSAGE_GAME: 'from-bannersage', BANNERLORDSAGE_GAME: 'from-bannerlord' },
    { BANNERSAGE_GAME: '', BANNERLORDSAGE_GAME: 'from-bannerlord' },
    { BANNERSAGE_GAME: '  ', BANNERLORDSAGE_GAME: 'from-bannerlord' },
    { BANNERSAGE_GAME: 'MIXED Case', BANNERLORDSAGE_GAME: '' },
    { BANNERSAGE_GAME: 'x', BANNERLORDSAGE_GAME: '' },
]
for (const combo of ENV_KEY_COMBOS) {
    const label = `getActiveGameId() with ${JSON.stringify(combo)}`
    await run(label, side => {
        const saved = {
            BANNERSAGE_GAME: process.env.BANNERSAGE_GAME,
            BANNERLORDSAGE_GAME: process.env.BANNERLORDSAGE_GAME,
        }
        const apply = (key, value) => {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        for (const key of Object.keys(saved)) apply(key, combo[key])
        let out
        try {
            out = mods['env'][side].getActiveGameId()
        } finally {
            for (const key of Object.keys(saved)) apply(key, saved[key])
        }
        return out
    })
}

// ── mod-source (pure surface) ───────────────────────────────────────────────
for (const dir of ['D:/tmp/x', 'C:\\a\\b', 'D:/A/B/', '中文/路径', '/', 'D:/a/b/c/d']) {
    await run(`getModSourcePaths(${JSON.stringify(dir)})`, side => mods['mod-source'][side].getModSourcePaths(dir))
}
for (const name of ['.git', '.GIT', ' .git ', 'bin', 'obj', '.vs', '.vscode', '.idea', 'src', 'srcs',
    'binaries', '', '  ', '中文', 'Bin']) {
    await run(`shouldSkipModSourceDirectory(${JSON.stringify(name)})`,
        side => mods['mod-source'][side].shouldSkipModSourceDirectory(name))
}
await run('MOD_SOURCE_IGNORED_DIRECTORY_NAMES', side => [...mods['mod-source'][side].MOD_SOURCE_IGNORED_DIRECTORY_NAMES])
for (const setting of [undefined, '', '   ', 'D:/mods', '  D:/mods  ', '\\\\srv\\share']) {
    await run(`getConfiguredModSourceDir() with BANNERSAGE_MOD_SOURCE_DIR=${JSON.stringify(setting)}`, side => {
        const savedBannerlord = process.env.BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR
        const savedGeneric = process.env.BANNERSAGE_MOD_SOURCE_DIR
        delete process.env.BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR
        if (setting === undefined) delete process.env.BANNERSAGE_MOD_SOURCE_DIR
        else process.env.BANNERSAGE_MOD_SOURCE_DIR = setting
        const out = mods['mod-source'][side].getConfiguredModSourceDir() ?? null
        if (savedBannerlord === undefined) delete process.env.BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR
        else process.env.BANNERSAGE_BANNERLORD_MOD_SOURCE_DIR = savedBannerlord
        if (savedGeneric === undefined) delete process.env.BANNERSAGE_MOD_SOURCE_DIR
        else process.env.BANNERSAGE_MOD_SOURCE_DIR = savedGeneric
        return out
    })
}

// ── local-mod-source alias layer ────────────────────────────────────────────
const scratch = mkdtempSync(join(tmpdir(), 'lms-'))
mkdirSync(join(scratch, 'src', 'deep'), { recursive: true })
writeFileSync(join(scratch, 'src', 'One.cs'), 'class One {}')
writeFileSync(join(scratch, 'src', 'Two.CS'), 'x')
writeFileSync(join(scratch, 'src', 'NotCSharp.txt'), 'x')
writeFileSync(join(scratch, 'src', 'deep', 'Three.cs'), 'y')
mkdirSync(join(scratch, 'src', 'obj'), { recursive: true })
writeFileSync(join(scratch, 'src', 'obj', 'Skipped.cs'), 'z')

for (const alias of ['countLocalModCSharpFiles', 'walkLocalModCSharpFiles']) {
    const collect = async side => {
        const fn = mods['local-mod-source'][side][alias]
        if (alias === 'walkLocalModCSharpFiles') {
            const out = []
            for await (const p of fn(join(scratch, 'src'))) out.push(p.split(scratch).join('<S>'))
            return out
        }
        return await fn(join(scratch, 'src'))
    }
    await run(`local-mod-source.${alias}`, collect)
}
await run('countModSourceCSharpFiles', side => mods['mod-source'][side].countModSourceCSharpFiles(join(scratch, 'src')))
await run('walkModSourceCSharpFiles', async side => {
    const out = []
    for await (const p of mods['mod-source'][side].walkModSourceCSharpFiles(join(scratch, 'src'))) {
        out.push(p.split(scratch).join('<S>'))
    }
    return out
})
await run('resolveModSourceWorkspace(missing)', async side => {
    const ws = await mods['mod-source'][side].resolveModSourceWorkspace(join(scratch, 'nope'))
    return ws.sourceRoot.split(scratch).join('<S>')
})
await run('resolveModSourceDir(blank)', side => mods['mod-source'][side].resolveModSourceDir('   '))

// ★ THE EFFECTIVE-SOURCE-ROOT RULE, enumerated. `resolveEffectiveSourceRoot` picks
// between three shapes (root already named `src` / root with a nested `src` / bare
// root), and it is only observable through resolveModSourceWorkspace, which also
// creates the cache directory. Each shape gets its own tree so the decision is
// visible rather than inferred, and the workspaceId doubles as proof that the
// resolved root - not the caller's argument - is what got hashed.
const layoutTrees = [
    { label: 'root itself is named src', build: root => mkdirSync(root, { recursive: true }) },
    {
        // ★ The only shape that separates "the root is already the source root"
        // from "prefer a nested src": the root is named `src` AND contains one
        // itself. Without this tree the two rules return the same path and the
        // precedence between them is untested - measured: a mutation that
        // disables the self-named rule survived the whole corpus before this
        // entry existed.
        label: 'root is named src and ALSO has a nested src',
        build: root => {
            mkdirSync(join(root, 'inner'), { recursive: true })
            mkdirSync(join(root, 'src'), { recursive: true })
            writeFileSync(join(root, 'outer.cs'), 'x')
            writeFileSync(join(root, 'src', 'inner.cs'), 'y')
        },
    },
    {
        label: 'root has a nested src',
        build: root => { mkdirSync(join(root, 'src', 'nested'), { recursive: true }); writeFileSync(join(root, 'src', 'a.cs'), 'x') },
    },
    {
        label: 'root has neither src nor a src-named self',
        build: root => { mkdirSync(join(root, 'plain'), { recursive: true }); writeFileSync(join(root, 'plain', 'a.cs'), 'x') },
    },
    {
        label: 'a FILE named src at the root (not a directory)',
        build: root => { mkdirSync(root, { recursive: true }); writeFileSync(join(root, 'src'), 'not a dir') },
    },
]
for (const [index, tree] of layoutTrees.entries()) {
    // The directory NAME decides the `src`-named-self case, so it is part of the case.
    const leaf = tree.label.startsWith('root itself is named src') || tree.label === 'root is named src and ALSO has a nested src'
        ? 'src'
        : `layout-${index}`
    const root = join(scratch, 'layouts', `case-${index}`, leaf)
    tree.build(root)
    await run(`resolveModSourceWorkspace(${tree.label})`, async side => {
        const ws = await mods['mod-source'][side].resolveModSourceWorkspace(root)
        const strip = value => value.split(scratch).join('<S>')
        return {
            workspaceRoot: strip(ws.workspaceRoot),
            sourceRoot: strip(ws.sourceRoot),
            sourceDir: strip(ws.sourceDir),
            workspaceId: ws.workspaceId,
            cacheRoot: strip(ws.cacheRoot),
        }
    })
    await run(`ensureModSourceDir(${tree.label})`, async side => {
        const resolved = await mods['mod-source'][side].ensureModSourceDir(root)
        return resolved.split(scratch).join('<S>')
    })
}
await run('resolveModSourceWorkspace(a FILE, not a directory)', async side => {
    const filePath = join(scratch, 'a-file.txt')
    writeFileSync(filePath, 'x')
    await mods['mod-source'][side].resolveModSourceWorkspace(filePath)
    return 'NO THROW'
})

// ── bannerlord-api-docs pure functions ──────────────────────────────────────
const versionInputs = [undefined, '', '   ', 'v1.2.9', 'V1.2.9', 'vv1.2.9', '1.2.9', '1.2', '1',
    '1.2.9.4.5', '1..2', '.1.2.3', '1.2.9.', 'a.b.c', '1.2.9rc1', ' v1.2 ', 'v', 'v.1.2']
for (const v of versionInputs) {
    await run(`normalizeApiVersion(${JSON.stringify(v)})`, side => mods['bannerlord-api-docs'][side].normalizeApiVersion(v) ?? null)
}
const pairs = [['1.2.9', '1.2.9'], ['1.2.9', '1.10.0'], ['1.10.0', '1.9.0'], ['1.2', '1.2.0'],
    ['1', '1.0.0'], ['1a', '1'], ['1e3', '1'], ['abc', '0'], ['', ''], ['-1', '1'], ['+2', '2']]
for (const [l, r] of pairs) {
    await run(`compareApiVersions(${l},${r})`, side => mods['bannerlord-api-docs'][side].compareApiVersions(l, r))
}
await run('BANNERLORD_API_SECTIONS', side => [...mods['bannerlord-api-docs'][side].BANNERLORD_API_SECTIONS])
await run('BANNERLORD_API_BASE_URL', side => mods['bannerlord-api-docs'][side].BANNERLORD_API_BASE_URL)

// ── bannerlord-api-docs: the db-backed half ─────────────────────────────────
// readIndexedApiVersions and resolveBannerlordApiVersion take a handle, so they
// need a real database. Without this section the resolution branches - and the
// exactMatch / authority / usage decision that turns on them - are covered only
// by the golden fixture suite, not here.
const { Database } = await import('bun:sqlite')
const apiDbDir = mkdtempSync(join(tmpdir(), 'apidocs-'))
const apiDbPath = join(apiDbDir, 'versions.db')
{
    const db = new Database(apiDbPath, { create: true })
    db.run('CREATE TABLE bannerlord_api_versions (version TEXT PRIMARY KEY)')
    // Chosen so the NUMERIC sort and a TEXTUAL sort disagree: as text "1.10.0" < "1.9.0".
    for (const v of ['1.2.9', '1.9.0', '1.10.0', '2.0.0']) {
        db.run('INSERT INTO bannerlord_api_versions (version) VALUES (?)', [v])
    }
    db.close()
}
const emptyApiDbPath = join(apiDbDir, 'empty.db')
{
    const db = new Database(emptyApiDbPath, { create: true })
    db.close()
}

for (const [label, path] of [['populated', apiDbPath], ['no table', emptyApiDbPath]]) {
    await run(`readIndexedApiVersions(${label})`, async side => {
        const db = new Database(path, { readonly: true })
        try { return mods['bannerlord-api-docs'][side].readIndexedApiVersions(db) } finally { db.close() }
    })
}

const setupStates = [
    { label: 'nothing installed, nothing requested', gameVersion: undefined, fullVersion: undefined, requested: undefined },
    { label: 'installed matches an indexed version', gameVersion: '1.2.9', fullVersion: '1.2.9.123', requested: undefined },
    { label: 'installed is absent', gameVersion: undefined, fullVersion: undefined, requested: undefined },
    { label: 'installed not indexed -> newest wins', gameVersion: '1.5.0', fullVersion: '1.5.0.9', requested: undefined },
    { label: 'fullVersion used when gameVersion is blank', gameVersion: '', fullVersion: '1.9.0.1', requested: undefined },
    { label: 'explicit request that exists', gameVersion: '1.2.9', fullVersion: undefined, requested: '1.9.0' },
    { label: 'explicit request that exists and matches', gameVersion: '1.9.0', fullVersion: undefined, requested: 'v1.9.0' },
    { label: 'explicit request that does not exist', gameVersion: '1.2.9', fullVersion: undefined, requested: '9.9.9' },
    { label: 'explicit request with no installed version', gameVersion: undefined, fullVersion: undefined, requested: '1.2.9' },
]
for (const path of [apiDbPath, emptyApiDbPath]) {
    const which = path === apiDbPath ? 'populated' : 'empty'
    for (const state of setupStates) {
        await run(`resolveBannerlordApiVersion(${which}, ${state.label})`, async side => {
            const db = new Database(path, { readonly: true })
            try {
                return mods['bannerlord-api-docs'][side].resolveBannerlordApiVersion(
                    db, { gameVersion: state.gameVersion, fullVersion: state.fullVersion }, state.requested)
            } finally { db.close() }
        })
    }
}

// ── bannerlord-entity-resolver (pure surface) ───────────────────────────────
const prefixCases = [
    ['Culture.culture_empire', ['Culture.']],
    ['Culture.', ['Culture.']],
    ['Faction.x', ['Culture.', 'Faction.']],
    ['x', ['Culture.']],
    ['', ['Culture.']],
    [null, ['Culture.']],
    [undefined, ['Culture.']],
]
for (const [value, prefixes] of prefixCases) {
    await run(`normalizeReference(${JSON.stringify(value)})`,
        side => mods['bannerlord-entity-resolver'][side].normalizeReference(value, prefixes))
}

// ★ ENUMERATION BEHIND "first match == last match". normalizeReference returns the
// FIRST prefix that matches, so this corpus cannot tell `.find` from `.findLast`
// unless one prefix in a passed set is a proper prefix of another. Every prefix
// set any call site in this repo passes is listed below; the harness ASSERTS that
// none of them nests, which is what makes the two equivalent for reachable input
// rather than merely untested.
const ALL_CALL_SITE_PREFIXES = [
    ['Culture.'],
    ['Hero.', 'NPCCharacter.'],
    ['Faction.', 'Clan.'],
    ['Faction.', 'Kingdom.'],
    ['Settlement.'],
]
const nestedPrefixSet = ALL_CALL_SITE_PREFIXES.find(
    set => set.some(a => set.some(b => a !== b && b.startsWith(a)))
)
if (nestedPrefixSet) {
    problems.push(
        `the corpus must contain a prefix set where first-match and last-match differ, ` +
        `but no call site passes one: ${JSON.stringify(nestedPrefixSet)}`
    )
}

for (const [raw, display] of [['Hero.x', 'Name'], ['Hero.x', null], ['Hero.x', ''], [null, 'Name'],
    [null, null], ['', ''], ['Faction.x', '{=abc}fallback']]) {
    await run(`formatReferenceLabel(${JSON.stringify(raw)},${JSON.stringify(display)})`,
        side => mods['bannerlord-entity-resolver'][side].formatReferenceLabel(raw, display))
}

// ── report ──────────────────────────────────────────────────────────────────
problems.forEach(p => console.log('MISMATCH ' + p))
console.log(`compared ${compared} values across ${Object.keys(mods).length} modules; ${problems.length} mismatch(es)`)
process.exit(problems.length === 0 ? 0 : 1)
