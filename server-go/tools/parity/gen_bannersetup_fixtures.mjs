// Parity fixture generator for the ported half of src/utils/bannerlord-setup.ts
//   splitCliList / composeFullVersion / getLogicalModuleName /
//   getPrimaryGameDirEnvName / getConfiguredGameDir / normalizeVersionText
//
// Most of these are module-private, so they are EXTRACTED VERBATIM by name (brace-matched) and
// assembled into a real .ts file in the OS scratch directory, then imported — the same approach the
// game-profiles generator uses, and for the same reason: retyping an expectation is how a fixture
// starts testing the author's reading instead of the code.
//
// getConfiguredGameDir reads process.env, so its corpus is a table of (env contents, expected)
// pairs evaluated against a temporary environment passed in through a lookup shim.
//
// Usage: bun run server-go/tools/parity/gen_bannersetup_fixtures.mjs

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const scratch = join(process.env.LOCALAPPDATA ?? '.', 'hermes', 'cache', 'scratch', 'op2')
const sourcePath = join(repoRoot, 'src', 'utils', 'bannerlord-setup.ts')
const sourceText = await Bun.file(sourcePath).text()
const NL = String.fromCharCode(10)

function extractFunction(name) {
  let start = sourceText.indexOf('async function ' + name + '(')
  if (start === -1) {
    start = sourceText.indexOf('function ' + name + '(')
    if (start === -1) throw new Error('FATAL: function ' + name + ' not found')
    if (/[A-Za-z0-9_$]/.test(sourceText[start - 1] ?? '')) {
      throw new Error('FATAL: found `function ' + name + '(` but not as a declaration')
    }
  }
  const open = sourceText.indexOf('{', start)
  let depth = 0
  for (let i = open; i < sourceText.length; i++) {
    if (sourceText[i] === '{') depth++
    else if (sourceText[i] === '}') {
      depth--
      if (depth === 0) return sourceText.slice(start, i + 1)
    }
  }
  throw new Error('FATAL: unbalanced braces for ' + name)
}

// ── assemble the extracted module ────────────────────────────────────────────
const lines = []
lines.push('// GENERATED - extracted verbatim from src/utils/bannerlord-setup.ts.')
lines.push('')
lines.push('function normalizeVersionText(value?: string): string | undefined {')
lines.push('  const text = value?.trim()')
lines.push('  return text || undefined')
lines.push('}')
lines.push('')
for (const name of ['splitCliList', 'composeFullVersion', 'getLogicalModuleName', 'getPrimaryGameDirEnvName', 'getConfiguredGameDir']) {
  lines.push(extractFunction(name))
  lines.push('')
}
lines.push('export { splitCliList, composeFullVersion, getLogicalModuleName, getPrimaryGameDirEnvName, getConfiguredGameDir, normalizeVersionText }')
lines.push('')

mkdirSync(scratch, { recursive: true })
const extractedPath = join(scratch, 'bannersetup_extracted.ts')
writeFileSync(extractedPath, lines.join(NL), 'utf8')
const mod = await import(pathToFileURL(extractedPath).href)

// public: EULA_DISCLAIMER, read from the real module
const real = await import(pathToFileURL(sourcePath).href)

// ── corpora ──────────────────────────────────────────────────────────────────
const splitCases = [
  [], [''], ['   '], ['a'], ['a,b'], ['a, b ,c'], ['a,,b'], [',,'], [' a '],
  ['a,b', 'c,d'], ['', 'a'], ['a,"b"'], ['中文, english'], ['a' + NL + 'b'],
].map(values => ({ values, result: mod.splitCliList(values) }))

const composeCases = [
  [undefined, undefined], ['1.2.3', undefined], [undefined, 'abc123'], ['1.2.3', 'abc123'],
  ['1.2.3.abc123', 'abc123'], ['1.2.3.', ''], ['', 'x'], ['1.2.3', '1'], ['1', '1'],
  ['v1.0.0', 'deadbeef'], ['0', '0'], ['a.b', 'b'],
].map(([v, c]) => ({
  gameVersion: v ?? null,
  buildChangeset: c ?? null,
  result: mod.composeFullVersion(v, c) ?? null,
}))

const moduleNameCases = [
  'Modules/Native/ModuleData/x.xml', 'modules/Lower/ModuleData/x.xml', 'Modules/Native',
  'Xmls/foo.xml', 'foo.xml', '/leading/slash.xml', 'Modules//Double/x.xml', 'Modules/',
  '', '/', 'Modules', 'Modules/x', 'a/b/c/d.xml', 'Modules\\Native\\x.xml'.replace(/\\\\/g, '\\'),
].map(p => {
  const out = mod.getLogicalModuleName(p)
  return { path: p, result: out ?? null }
})

const envNameCases = [
  'bannerlord', 'Bannerlord', '  bannerlord  ', 'some game', 'a--b', '!a', 'a!',
  'a b  c', 'x_y', 'UPPER', '123', '-', '', '  ', 'a.b.c', 'game/2',
].map(id => ({ id, result: mod.getPrimaryGameDirEnvName(id) }))

// getConfiguredGameDir reads process.env DIRECTLY — it takes no lookup parameter — so each case
// sets the real environment variables before calling it and restores them afterwards. Passing a
// shim would have produced a fixture whose expectations were all null while looking plausible, which
// is exactly what happened on the first attempt: eight cases recorded `null` and the Go side was
// right.
const ENV_KEYS = [
  'BANNERSAGE_BANNERLORD_GAME_DIR',
  'BANNERSAGE_SOME_GAME_GAME_DIR',
  'BANNERSAGE__A_GAME_DIR',
  'BANNERSAGE_GAME_DIR',
  'BANNERLORD_GAME_DIR',
]
const configuredCases = []
for (const [gameId, env, note] of [
  ['bannerlord', {}, 'nothing set'],
  ['bannerlord', { BANNERSAGE_BANNERLORD_GAME_DIR: 'D:/per-game' }, 'per-game wins'],
  ['bannerlord', { BANNERSAGE_GAME_DIR: 'D:/generic' }, 'generic used'],
  ['bannerlord', { BANNERLORD_GAME_DIR: 'D:/legacy' }, 'legacy used for bannerlord'],
  ['othergame', { BANNERLORD_GAME_DIR: 'D:/legacy' }, 'legacy NOT used for another id'],
  ['bannerlord', { BANNERSAGE_BANNERLORD_GAME_DIR: '', BANNERSAGE_GAME_DIR: 'D:/generic' }, 'empty per-game falls through'],
  ['bannerlord', { BANNERSAGE_GAME_DIR: '', BANNERLORD_GAME_DIR: 'D:/legacy' }, 'empty generic falls through'],
  ['bannerlord', { BANNERSAGE_BANNERLORD_GAME_DIR: 'x', BANNERLORD_GAME_DIR: 'D:/legacy' }, 'per-game stops the search'],
  ['some game', { BANNERSAGE_SOME_GAME_GAME_DIR: 'D:/spaced' }, 'normalised variable name'],
  ['!a', { BANNERSAGE__A_GAME_DIR: 'D:/bang' }, 'leading separator in the name'],
]) {
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [k, v] of Object.entries(env)) process.env[k] = v
  const out = mod.getConfiguredGameDir(gameId)
  configuredCases.push({ gameId, env, note, result: out ?? null })
}
for (const key of ENV_KEYS) delete process.env[key]

const versionTextCases = [undefined, null, '', '   ', ' 1.2.3 ', 'x', NL + 'v' + NL].map(v => ({
  value: v ?? null,
  result: mod.normalizeVersionText(v ?? undefined) ?? null,
}))

const fixtures = {
  _comment:
    'GENERATED by gen_bannersetup_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/bannerlord-setup.ts, with its module-private helpers extracted verbatim by name. ' +
    'Do not edit by hand.',
  eulaDisclaimer: real.EULA_DISCLAIMER,
  splitCases,
  composeCases,
  moduleNameCases,
  envNameCases,
  configuredCases,
  versionTextCases,
}
writeFileSync(join(here, 'bannersetup_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote bannersetup_fixtures.json')
console.log('  splitCliList          : ' + splitCases.length)
console.log('  composeFullVersion    : ' + composeCases.length)
console.log('  getLogicalModuleName  : ' + moduleNameCases.length)
console.log('  getPrimaryGameDirEnvName: ' + envNameCases.length)
console.log('  getConfiguredGameDir  : ' + configuredCases.length)
console.log('  normalizeVersionText  : ' + versionTextCases.length)
console.log('')
console.log('  ★ env name normalisation (the collapsing rule):')
for (const c of envNameCases) console.log('      ' + JSON.stringify(c.id).padEnd(18) + ' -> ' + JSON.stringify(c.result))
