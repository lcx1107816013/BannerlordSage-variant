// Parity fixture generator for src/utils/game-profiles.ts
//   getXmlValue / isBannerlordOfficialRootBinDll / isBannerlordModdingRootBinDll /
//   classifyBannerlordModules / bannerlordProfile.scoreDllPath
//
// The module-private functions are EXTRACTED VERBATIM from the source text by name (brace-matched),
// never retyped — a rename upstream must break this loudly rather than silently produce a fixture
// that matches nothing.
//
// classifyBannerlordModules reads a DIRECTORY, so this generator builds a small Modules/ tree
// under fixtures/ and runs the real classifier over it. That corpus is committed, so the Go side
// reads the SAME tree.
//
// Usage: bun run server-go/tools/parity/gen_gameprofiles_fixtures.mjs

import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const scratch = join(process.env.LOCALAPPDATA ?? '.', 'hermes', 'cache', 'scratch', 'op2')
// A literal newline, built without an escape sequence so no tool in the chain can mangle it.
const STRING_BREAK = String.fromCharCode(10)

function extractFunction(sourceText, name, fileForErrors) {
  // The declaration may be `function name(` or `async function name(`. The plain search finds the
  // substring INSIDE the async form too, which silently dropped the `async` keyword and produced a
  // module whose `await` was illegal — so the character before the match is checked, and the async
  // form wins when present.
  let start = sourceText.indexOf('async function ' + name + '(')
  if (start === -1) {
    start = sourceText.indexOf('function ' + name + '(')
    if (start === -1) throw new Error('FATAL: function ' + name + ' not found in ' + fileForErrors)
    const before = start > 0 ? sourceText[start - 1] : ''
    // A preceding word character means this is not the declaration (e.g. `myfunction name(`).
    if (/[A-Za-z0-9_$]/.test(before)) {
      throw new Error('FATAL: found `function ' + name + '(` but not as a declaration')
    }
  }
  const open = sourceText.indexOf('{', start)
  if (open === -1) throw new Error(`FATAL: no body for ${name} in ${fileForErrors}`)
  let depth = 0
  for (let i = open; i < sourceText.length; i++) {
    if (sourceText[i] === '{') depth++
    else if (sourceText[i] === '}') {
      depth--
      if (depth === 0) return sourceText.slice(start, i + 1)
    }
  }
  throw new Error(`FATAL: unbalanced braces for ${name} in ${fileForErrors}`)
}

const sourcePath = join(repoRoot, 'src', 'utils', 'game-profiles.ts')
const sourceText = await Bun.file(sourcePath).text()

// The module-private helpers, taken from the real file, in the order they must appear (a function
// used by another has to be declared first for a plain function declaration? no — declarations
// hoist, so order does not matter — but keeping source order makes the diff readable).
const privates = [
  'pathExists',
  'getXmlValue',
  'isBannerlordOfficialRootBinDll',
  'isBannerlordModdingRootBinDll',
  'classifyBannerlordModules',
]
const extracted = privates.map(name => extractFunction(sourceText, name, sourcePath))

// Build a module that re-declares the constants the extracted functions close over. The constants
// themselves are read by evaluating the real module and reaching in through the profile, but the
// extracted text references the module-scope identifiers directly, so they must exist in the
// evaluation scope. They are copied from the source by REGEX rather than retyped.
function extractConst(name) {
  // Locate `const NAME = [` and take through the matching `]`, plus any same-statement tail.
  const marker = 'const ' + name + ' = '
  const start = sourceText.indexOf(marker)
  if (start === -1) throw new Error('FATAL: const ' + name + ' not found')
  const open = sourceText.indexOf('[', start)
  let depth = 0
  let i = open
  for (; i < sourceText.length; i++) {
    if (sourceText[i] === '[') depth++
    else if (sourceText[i] === ']') {
      depth--
      if (depth === 0) break
    }
  }
  if (depth !== 0) throw new Error('FATAL: unbalanced brackets for ' + name)
  const lineEnd = sourceText.indexOf(STRING_BREAK, i)
  // keeps a trailing `.map(...)` that is part of the same statement
  return sourceText.slice(start, lineEnd === -1 ? undefined : lineEnd)
}

const constText = [
  extractConst('BANNERLORD_OFFICIAL_MODULE_IDS'),
  extractConst('BANNERLORD_ROOT_BIN_DLL_PREFIXES'),
  extractConst('BANNERLORD_MODDING_SUPPORT_DLLS'),
  extractConst('BANNERLORD_MODDING_ROOT_BIN_EXCLUDES'),
  extractConst('BANNERLORD_ROOT_BIN_DLL_DENYLIST'),
].join(STRING_BREAK)

const { readdir, readFile, stat } = await import('node:fs/promises')
const { join: pathJoin, basename } = await import('node:path')

const moduleSource = [
  '// GENERATED - extracted verbatim from src/utils/game-profiles.ts.',
  'import { readFile, readdir, stat } from "node:fs/promises"',
  'import { basename, join } from "node:path"',
  '',
  'type XmlModuleClassification = {',
  '  moduleName: string',
  '  moduleId: string',
  '  moduleType: string | null',
  '  officialFlag: boolean | null',
  '  metadataSuggestsOfficial: boolean',
  '  isOfficial: boolean',
  '  reason: string',
  '  moduleDir: string',
  '}',
  '',
  constText,
  '',
  extracted.join(STRING_BREAK),
  '',
  'export { getXmlValue, isBannerlordOfficialRootBinDll, isBannerlordModdingRootBinDll, classifyBannerlordModules }',
  '',
].join(STRING_BREAK)

mkdirSync(scratch, { recursive: true })
const extractedPath = join(scratch, 'gameprofiles_extracted.ts')
writeFileSync(extractedPath, moduleSource, 'utf8')
const mod = await import(pathToFileURL(extractedPath).href)

// ── the fixture Modules/ tree ────────────────────────────────────────────────
const fixturesRoot = join(here, 'fixtures', 'gameprofiles')
const modulesDir = join(fixturesRoot, 'Modules')
if (existsSync(fixturesRoot)) rmSync(fixturesRoot, { recursive: true })
mkdirSync(modulesDir, { recursive: true })

const writeModule = (dirName, subModuleXML) => {
  const dir = join(modulesDir, dirName)
  mkdirSync(dir, { recursive: true })
  if (subModuleXML !== null) writeFileSync(join(dir, 'SubModule.xml'), subModuleXML, 'utf8')
  return dir
}

// A plain official module, recognised by the ALLOWLIST.
writeModule('Native', `<Module><Id value="Native" /><ModuleType value="Official" /></Module>`)
// A community module with metadata claiming official: recorded, but NOT official.
writeModule('ClaimedOfficial', `<Module><Id value="ClaimedOfficial" /><ModuleType value="Official" /></Module>`)
// officialFlag true, no ModuleType.
writeModule('FlagTrue', `<Module><Id value="FlagTrue" /><Official value="true" /></Module>`)
// officialFlag present but not "true" — false rather than absent.
writeModule('FlagGarbage', `<Module><Id value="FlagGarbage" /><Official value="yes" /></Module>`)
// A module whose DIRECTORY is not allowlisted but whose Id IS.
writeModule('RenamedDir', `<Module><Id value="Native" /></Module>`)
// No SubModule.xml at all: the Id falls back to the directory name.
writeModule('NoManifest', null)
// A lowercase ModuleType and surrounding whitespace.
writeModule('LowerType', `<Module><Id value="LowerType" /><ModuleType value="  officialOptional  " /></Module>`)
// An empty module element.
writeModule('Empty', `<Module></Module>`)
// A moduleType that is present but neither official spelling.
writeModule('OtherType', `<Module><Id value="OtherType" /><ModuleType value="Community" /></Module>`)

const classifications = await mod.classifyBannerlordModules(modulesDir)

// ── pure-function corpora ────────────────────────────────────────────────────
const xmlValueCases = []
for (const [raw, tag] of [
  ['<Module>\n <Id value="Native" />\n</Module>', 'Id'],
  ['<Module>\n <Id value="Native" />\n</Module>', 'id'],
  ['<Module><Id value = "Spaced" /></Module>', 'Id'],
  ["<Module><Id value='Single' /></Module>", 'Id'],
  ['<Module><Id value="" /></Module>', 'Id'],
  ['<Module><Id value="A" /><Id value="B" /></Module>', 'Id'],
  ['<Module><!-- <Id value="InComment" /> --></Module>', 'Id'],
  ['<Module><Id Xvalue="NotIt" /></Module>', 'Id'],
  ['<Module><ModuleType value="Official"/></Module>', 'ModuleType'],
  ['', 'Id'],
  ['<Module><Id/></Module>', 'Id'],
  ['<Module><I.d value="Escaped" /></Module>', 'I.d'],
  ['<Module><Id value="Unclosed /></Module>', 'Id'],
]) {
  xmlValueCases.push({ raw, tag, result: mod.getXmlValue(raw, tag) })
}

const officialBinCases = [
  'TaleWorlds.Core.dll', 'taleworlds.core.dll', 'SandBox.dll', 'StoryMode.dll',
  'CustomBattle.dll', 'NavalDLC.dll', 'Newtonsoft.Json.dll', 'Bannerlord.BLSE.Shared.dll',
  'TaleWorlds.Native.dll', 'Other.dll', 'TaleWorlds.dll', 'TaleWorlds.CampaignSystem.View.dll',
  'C:/game/bin/Win64_Shipping_Client/TaleWorlds.Core.dll',
].map(p => ({ path: p, result: mod.isBannerlordOfficialRootBinDll(p) }))

const moddingBinCases = [
  'Newtonsoft.Json.dll', 'Steamworks.NET.dll', 'StbSharp.dll', 'System.Management.dll',
  'System.Numerics.Vectors.dll', 'TaleWorlds.Diamond.AccessProvider.DLL',
  'TaleWorlds.MountAndBlade.Launcher.exe.dll', 'TaleWorlds.PlatformService.dll',
  'TaleWorlds.PlatformService.Client.dll', 'TaleWorlds.ServiceDiscovery.Client.dll',
  'TaleWorlds.Starter.Library.dll', 'Something.Test.dll', 'TaleWorlds.Core.dll',
  'Other.dll', 'Bannerlord.BLSE.Shared.dll',
].map(p => ({ path: p, result: mod.isBannerlordModdingRootBinDll(p) }))

// scoreDllPath comes from the real profile object.
const profileMod = await import(pathToFileURL(sourcePath).href)
const profile = profileMod.getGameProfile('bannerlord')
const scoreCases = [
  'C:/game/bin/Win64_Shipping_Client/TaleWorlds.Core.dll',
  'C:/game/Modules/Native/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.View.dll',
  'C:/game/bin/Other/x.dll',
  'C:/game/Modules/Native/bin/Other/x.dll',
  'C:/game/elsewhere/x.dll',
  'C:\\game\\BIN\\WIN64_SHIPPING_CLIENT\\a.dll',
  'C:/game/bin/win64_shipping_client/modules/x.dll',
].map(p => ({ path: p, result: profile.scoreDllPath(p) }))

const fixtures = {
  _comment:
    'GENERATED by gen_gameprofiles_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/game-profiles.ts (public exports) and its module-private helpers extracted ' +
    'verbatim by name. Do not edit by hand.',
  modulesRoot: 'tools/parity/fixtures/gameprofiles/Modules',
  moduleMetadata: [
    { dir: 'Native', id: '', type: 'Official' },
    { dir: 'ClaimedOfficial', id: 'ClaimedOfficial', type: 'Official' },
  ],
  classifications,
  xmlValueCases,
  officialBinCases,
  moddingBinCases,
  scoreCases,
}
writeFileSync(join(here, 'gameprofiles_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

console.log('wrote gameprofiles_fixtures.json + fixtures/gameprofiles/Modules/')
console.log(`  classifications : ${classifications.length}`)
console.log(`  xmlValue        : ${xmlValueCases.length}`)
console.log(`  officialBin     : ${officialBinCases.length}`)
console.log(`  moddingBin      : ${moddingBinCases.length}`)
console.log(`  scoreDllPath    : ${scoreCases.length}`)
console.log()
console.log('  ★ classification results (dir -> isOfficial / reason):')
for (const c of classifications) {
  console.log(`      ${c.moduleName.padEnd(16)} ${String(c.isOfficial).padEnd(5)} ${c.reason}`)
}
