// Parity fixture generator for src/tools/generate-harmony-patch.ts -> tools.GenerateHarmonyPatch.
//
// The tool calls getDb() for the ACTIVE game, so — like gen_searchapidocs_fixtures.mjs —
// the database module is injected with mock.module and handed a fixture database under
// tools/parity/fixtures/. The corpus is crafted so every branch the template has is
// exercised with REAL TypeScript output:
//
//   * a type whose fullName tiebreak matters: two MobileParty rows where the SHORTEST
//     fullName wins (ORDER BY LENGTH(fullName), filePath LIMIT 1)
//   * the missing-type branch ('Type not found: X')
//   * one instance method (instanceParamHint = the spliced parameter)
//   * two overloads where ONE is an instance method (the marker-comment branch)
//   * all-static methods (empty hint)
//   * a method the type does not have (the 'not found in AST index' sentence)
//   * generic + array + ref/params/default-value parameters, so buildTypeHint's
//     comma-splitting at nesting depth 0 only, the modifier strip, and the
//     default-value split are all observable in the rendered overload hints
//   * a signature with NO parameters (no 'Overload hint' line under its comment)
//
// Usage: bun run server-go/tools/parity/gen_harmonypatch_fixtures.mjs

import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

// ── the AST corpus ───────────────────────────────────────────────────────────
const dbPath = join(fixturesDir, 'harmonypatch.db')
removeOwnFixtureOrRefuse(dbPath, 'gen_harmonypatch_fixtures.mjs')
const db = new Database(dbPath)
db.run(`CREATE TABLE csharp_types (
  typeName TEXT, fullName TEXT, filePath TEXT,
  startLine INTEGER, endLine INTEGER, typeKind TEXT, accessibility TEXT, modifiers TEXT
)`)
db.run(`CREATE TABLE csharp_methods (
  id TEXT PRIMARY KEY, typeFullName TEXT, memberName TEXT, memberKind TEXT,
  signature TEXT, returnType TEXT, filePath TEXT,
  startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER
)`)
markAsFixture(db, 'gen_harmonypatch_fixtures.mjs')

// Rows named MobileParty: the SHORTEST fullName must win the type lookup.
// ★ The AMobileParty row is ALPHABETICALLY FIRST but LONGER — it wins under
//   ORDER BY fullName and loses under ORDER BY LENGTH(fullName), which is the only way
//   the ordering rule is observable. The first mutation check ran without this row and
//   an ORDER BY fullName mutation SURVIVED, because the two original rows happen to
//   agree under both orderings.
db.run(`INSERT INTO csharp_types VALUES ('MobileParty','TaleWorlds.AMobileParty.WithAVeryLongSuffixIndeed','AMobileParty.cs',1,50,'class','public','')`)
db.run(`INSERT INTO csharp_types VALUES ('MobileParty','TaleWorlds.CampaignSystem.MobileParty','CampaignSystem/MobileParty.cs',10,500,'class','public','')`)
db.run(`INSERT INTO csharp_types VALUES ('MobileParty','TaleWorlds.CampaignSystem.Party.MobileParty.MobilePartyInner','CampaignSystem/Party.cs',1,50,'class','public','')`)
db.run(`INSERT INTO csharp_types VALUES ('MathUtil','TaleWorlds.Core.MathUtil','Core/MathUtil.cs',1,80,'class','public','static')`)

const insertMethod = db.prepare(`INSERT INTO csharp_methods (id, typeFullName, memberName, memberKind, signature, returnType, filePath, startLine, endLine, accessibility, isStatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)

// One instance method -> the spliced __instance parameter.
insertMethod.run('m1', 'TaleWorlds.CampaignSystem.MobileParty', 'CalculateSpeed', 'method', 'public float CalculateSpeed()', 'float', 'CampaignSystem/MobileParty.cs', 100, 110, 'public', 0)

// Two overloads, ONE instance -> the marker comment.
insertMethod.run('m2', 'TaleWorlds.CampaignSystem.MobileParty', 'GetMember', 'method', 'public PartyMemberRandom GetMember()', 'PartyMemberRandom', 'CampaignSystem/MobileParty.cs', 120, 125, 'public', 1)
insertMethod.run('m3', 'TaleWorlds.CampaignSystem.MobileParty', 'GetMember', 'method', 'public PartyMemberRandom GetMember(int index)', 'PartyMemberRandom', 'CampaignSystem/MobileParty.cs', 126, 130, 'public', 0)

// All static -> empty hint.
insertMethod.run('m4', 'TaleWorlds.Core.MathUtil', 'Clamp', 'method', 'public static float Clamp(float value, float min, float max)', 'float', 'Core/MathUtil.cs', 10, 12, 'public', 1)

// Generic + array + modifiers + default: buildTypeHint's whole surface.
insertMethod.run('m5', 'TaleWorlds.Core.MathUtil', 'ApplyAll', 'method', 'public static void ApplyAll(List<Dictionary<string, int>> maps, params int[] xs, ref Foo bar, bool keep = true)', 'void', 'Core/MathUtil.cs', 20, 30, 'public', 1)

// No-parameter signature but WITH parens content empty is m1; a truly empty signature
// (no parens at all) exercises the start==-1 branch.
insertMethod.run('m6', 'TaleWorlds.Core.MathUtil', 'WeirdMacro', 'method', 'WEIRD_MACRO_BODY', 'void', 'Core/MathUtil.cs', 40, 41, 'public', 1)
db.close()

// ── module-level injection ───────────────────────────────────────────────────
const dbReal = join(repoRoot, 'src', 'utils', 'db.ts')
mock.module(dbReal, () => ({
  getDb: () => new Database(dbPath, { readonly: true }),
  closeDb: () => {},
  databaseHasTable: () => false,
  databaseHasColumns: () => false,
  databaseTableRowCount: () => 0,
  databaseTableRowCountWhereEquals: () => 0,
  databaseTextValue: () => null,
}))

const harmonyMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'generate-harmony-patch.ts')).href)
const { generateHarmonyPatch } = harmonyMod

const CASES = [
  { label: 'shortest fullName wins the type lookup; one instance method', className: 'MobileParty', methodName: 'CalculateSpeed' },
  { label: 'two overloads, one instance -> marker comment + per-overload hints', className: 'MobileParty', methodName: 'GetMember' },
  { label: 'all-static methods -> empty instance hint', className: 'MathUtil', methodName: 'Clamp' },
  { label: 'generic/array/modifier/default parameters in the hint', className: 'MathUtil', methodName: 'ApplyAll' },
  { label: 'signature with no parens -> no overload-hint line', className: 'MathUtil', methodName: 'WeirdMacro' },
  { label: 'type exists, method does not -> the AST-index sentence', className: 'MathUtil', methodName: 'NopeMissing' },
  { label: 'type missing entirely', className: 'NotThereAtAll', methodName: 'Anything' },
]

const out = []
for (const c of CASES) {
  let entry
  try {
    const res = await generateHarmonyPatch(c.className, c.methodName)
    entry = { ...c, ok: true, text: res.content[0].text }
  } catch (error) {
    entry = { ...c, ok: false, error: String(error?.message ?? error) }
  }
  out.push(entry)
}

const fixtures = {
  _comment:
    'GENERATED by gen_harmonypatch_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/tools/generate-harmony-patch.ts with its db module injected via mock.module, against the ' +
    'committed AST corpus below. Do not edit by hand.',
  dbPath: 'tools/parity/fixtures/harmonypatch.db',
  cases: out,
}
writeFileSync(join(here, 'harmonypatch_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

const rendered = out.filter(c => c.ok)
console.log('wrote harmonypatch_fixtures.json + fixtures/harmonypatch.db')
console.log('  cases: ' + out.length + ' (' + rendered.length + ' rendered)')
const overload = rendered.find(c => c.methodName === 'GetMember')
if (overload) {
  console.log('  ★ the two-overload case, first 8 lines:')
  console.log(overload.text.split(NL).slice(0, 8).map(l => '      ' + l).join(NL))
}
