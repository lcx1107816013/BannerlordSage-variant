// Parity fixture generator for src/utils/bannerlord-entity-resolver.ts
//   normalizeReference / lookupCultureName / lookupHeroName / lookupClanInfo / lookupKingdomInfo /
//   lookupPolicyName / lookupSettlementInfo / formatReferenceLabel
// and src/utils/bannerlord-policy-id.ts -> policyid.Normalize.
//
// The lookups query real tables, so this builds a fixture database carrying the SIX schemas copied
// from the real index (read-only, once) and fills them with a crafted corpus. The rows are chosen to
// separate the ORDER BY rules rather than to look realistic:
//   * a culture with TWO rows differing in name counts and description presence
//   * a troop with two rows differing only in filePath (the tiebreaker)
//   * a clan with three rows: noble / minor-faction / neither, all with the same clanId
//   * a policy reachable only through the alias, and one reachable only through the prefix strip
//
// Usage: bun run server-go/tools/parity/gen_entityresolver_fixtures.mjs

import { mock } from 'bun:test'
import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

const REAL_DB = join(repoRoot, 'dist', 'games', 'bannerlord', 'bannerlord.db')
const dbPath = join(fixturesDir, 'entityresolver.db')
removeOwnFixtureOrRefuse(dbPath, 'gen_entityresolver_fixtures.mjs')

const db = new Database(dbPath)
markAsFixture(db, 'gen_entityresolver_fixtures.mjs')

// ── schemas: copied from the real index, read-only ──────────────────────────
// A missing real index would mean there is nothing to copy, so the generator says so rather than
// inventing a schema and producing evidence about a shape the real index does not have.
if (!existsSync(REAL_DB)) {
  console.error(`REFUSING: the real index is absent (${REAL_DB}); the schemas below are copied from it, not invented.`)
  process.exit(3)
}
const real = new Database(REAL_DB, { readonly: true })
const TABLES = ['bannerlord_cultures', 'bannerlord_troops', 'bannerlord_clans',
  'bannerlord_kingdoms', 'bannerlord_policies', 'bannerlord_settlements',
  // The two localization tables exist so the tokenised-label case resolves against THIS database
  // instead of the real index. They are deliberately left EMPTY: an empty map is what the fallback
  // branch needs, and empty tables keep the expectation independent of any machine's index.
  'localization_entries', 'source_localization_entries']
for (const t of TABLES) {
  const row = real.query(`SELECT sql FROM sqlite_master WHERE name = ?`).get(t)
  if (!row) {
    console.error(`REFUSING: ${t} is absent from the real index; the fixture cannot mirror it.`)
    process.exit(3)
  }
  db.run(row.sql)
}
real.close()

// ── corpus ──────────────────────────────────────────────────────────────────
// CULTURES: the same cultureId twice. Row A has a description but fewer names; row B has more
// names and no description. The ORDER BY puts name counts FIRST, so B must win — a port that
// reordered the two clauses would return A's name.
db.run(`INSERT INTO bannerlord_cultures (cultureId, filePath, name, descriptionText, isMainCulture, maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount)
        VALUES ('vlandia', 'b/z.xml', 'Vlandia-B', NULL, 1, 30, 30, '[]', 0)`)
db.run(`INSERT INTO bannerlord_cultures (cultureId, filePath, name, descriptionText, isMainCulture, maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount)
        VALUES ('vlandia', 'a/y.xml', 'Vlandia-A', 'has a description', 1, 1, 1, '[]', 0)`)
// A culture whose winning row has NO description, to show the description clause is a tiebreak only.
db.run(`INSERT INTO bannerlord_cultures (cultureId, filePath, name, descriptionText, isMainCulture, maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount)
        VALUES ('empire', 'a/e.xml', NULL, NULL, 1, 5, 5, '[]', 0)`)
db.run(`INSERT INTO bannerlord_cultures (cultureId, filePath, name, descriptionText, isMainCulture, maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount)
        VALUES ('empire', 'b/e2.xml', 'Empire', 'described', 1, 0, 0, '[]', 0)`)

// TROOPS: identical name counts, so only the filePath tiebreaker decides.
db.run(`INSERT INTO bannerlord_troops (characterId, filePath, name, isHero, isFemale, upgradeTargetsJson)
        VALUES ('lord_1', 'zzz.xml', 'Lord Zed', 1, 0, '[]')`)
db.run(`INSERT INTO bannerlord_troops (characterId, filePath, name, isHero, isFemale, upgradeTargetsJson)
        VALUES ('lord_1', 'aaa.xml', 'Lord Aaa', 1, 0, '[]')`)
// A troop row with a NULL name, to reach the null-name branch.
db.run(`INSERT INTO bannerlord_troops (characterId, filePath, name, isHero, isFemale, upgradeTargetsJson)
        VALUES ('nameless', 'a/n.xml', NULL, 0, 0, '[]')`)

// CLANS: one clanId, three rows — the ORDER BY ranks noble above minor-faction above the rest.
db.run(`INSERT INTO bannerlord_clans (clanId, filePath, name, superFaction, isNoble, isMinorFaction, isBandit, isOutlaw, isMafia, isMercenary, templateCount)
        VALUES ('clan_x', 'a/noble.xml', 'Noble Row', 'Kingdom.vlandia', 1, 0, 0, 0, 0, 0, 0)`)
db.run(`INSERT INTO bannerlord_clans (clanId, filePath, name, superFaction, isNoble, isMinorFaction, isBandit, isOutlaw, isMafia, isMercenary, templateCount)
        VALUES ('clan_x', 'a/minor.xml', 'Minor Row', NULL, 0, 1, 0, 0, 0, 0, 0)`)
db.run(`INSERT INTO bannerlord_clans (clanId, filePath, name, superFaction, isNoble, isMinorFaction, isBandit, isOutlaw, isMafia, isMercenary, templateCount)
        VALUES ('clan_x', 'a/plain.xml', 'Plain Row', NULL, 0, 0, 0, 0, 0, 0, 0)`)
// A clan whose only row is a minor faction, to show the ranking is not "prefer non-minor".
db.run(`INSERT INTO bannerlord_clans (clanId, filePath, name, superFaction, isNoble, isMinorFaction, isBandit, isOutlaw, isMafia, isMercenary, templateCount)
        VALUES ('clan_minor_only', 'a/only.xml', 'Only Minor', NULL, 0, 1, 0, 0, 0, 0, 0)`)

// KINGDOMS
db.run(`INSERT INTO bannerlord_kingdoms (kingdomId, filePath, name, relationshipCount, policyCount, policyIdsJson)
        VALUES ('vlandia', 'b/k.xml', 'Kingdom B', 0, 0, '[]')`)
db.run(`INSERT INTO bannerlord_kingdoms (kingdomId, filePath, name, relationshipCount, policyCount, policyIdsJson)
        VALUES ('vlandia', 'a/k.xml', 'Kingdom A', 0, 0, '[]')`)

// POLICIES: a table keyed like the real one (policyId PRIMARY KEY), with the alias target present
// and an unrelated row to show a plain lookup still works.
db.run(`INSERT INTO bannerlord_policies (policyId, rawPolicyId, filePath, sourceModule, displayName, activeKingdomIdsJson, defaultCultureIdsJson, activeKingdomCount, defaultCultureCount)
        VALUES ('policy_land_grants_for_veterans', 'policy_land_grants_for_veterans', 'a/p.xml', 'M', 'Land Grants', '[]', '[]', 0, 0)`)
db.run(`INSERT INTO bannerlord_policies (policyId, rawPolicyId, filePath, sourceModule, displayName, activeKingdomIdsJson, defaultCultureIdsJson, activeKingdomCount, defaultCultureCount)
        VALUES ('policy_other', 'policy_other', 'a/p2.xml', 'M', NULL, '[]', '[]', 0, 0)`)
// ★ THE PRE-ALIAS SPELLING IS NOT STORED. Some game files write `..._grands_for_veteran`, the index
// stores `..._grants_for_veterans`, and the alias exists so a caller's spelling still resolves. A
// row with the misspelt id would make the alias unnecessary and the case would prove nothing.
// (Asserted below rather than left to a reader to notice.)

// SETTLEMENTS
db.run(`INSERT INTO bannerlord_settlements (settlementId, filePath, name, owner, boundSettlement, settlementType, locationCount, buildingCount)
        VALUES ('town_V1', 'a/s.xml', 'Settlement A', 'Clan.clan_x', 'castle_V1', 'Town', 0, 0)`)
db.run(`INSERT INTO bannerlord_settlements (settlementId, filePath, name, owner, boundSettlement, settlementType, locationCount, buildingCount)
        VALUES ('town_V1', 'b/s.xml', 'Settlement B', NULL, NULL, NULL, 0, 0)`)

const aliasRowPresent = db.query(`SELECT COUNT(*) AS n FROM bannerlord_policies WHERE policyId = 'policy_land_grands_for_veteran'`).get().n
if (aliasRowPresent !== 0) {
  console.error('REFUSING: the corpus stores the misspelt policy id, which makes the alias case vacuous.')
  process.exit(3)
}

// ── run the real TypeScript ─────────────────────────────────────────────────
//
// ★ THE TOKENISED-LABEL CASE NEEDS THE DATABASE INJECTED, NOT JUST PASSED IN. formatReferenceLabel
// reaches resolveMaybeLocalizedText, which reads the runtime database through getDb() — it does not
// take a handle. So a corpus that only passes `db` would compute that one expectation against the
// REAL index (600 MB, present on this machine, absent on a fresh clone), which is precisely the
// "passes here, fails on a new clone" failure the harness README calls out. The two modules are
// therefore replaced at the module level so the whole chain reads the FIXTURE.
const envReal = join(repoRoot, 'src', 'utils', 'env.ts')
const dbReal = join(repoRoot, 'src', 'utils', 'db.ts')
let ACTIVE_DB_PATH = dbPath

mock.module(envReal, () => ({
  DEFAULT_GAME_ID: 'bannerlord',
  root: repoRoot,
  distPath: join(repoRoot, 'dist'),
  gamesDistPath: join(repoRoot, 'dist', 'games'),
  normalizeGameId: id => id?.trim().toLowerCase() || 'bannerlord',
  getActiveGameId: () => 'bannerlord',
  getGamePaths: gameId => ({ gameId: gameId ?? 'bannerlord', dbPath: ACTIVE_DB_PATH }),
  activeGameId: 'bannerlord',
  activeGamePaths: { dbPath: ACTIVE_DB_PATH },
  assetsPath: '', versionPath: '', defsPath: '', sourcePath: '',
  dbPath: ACTIVE_DB_PATH, memoryDbPath: '', setupStatePath: '', csharpAstDumpPath: '',
}))
mock.module(dbReal, () => ({
  getDb: () => {
    const h = new Database(ACTIVE_DB_PATH, { readonly: true })
    return h
  },
  databaseHasTable: (path, tableName) => {
    try {
      const probe = new Database(path, { create: false, readonly: true })
      try {
        return Boolean(probe.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(tableName))
      } finally {
        probe.close()
      }
    } catch {
      return false
    }
  },
  closeDb: () => {},
  databaseHasColumns: () => false,
  databaseTableRowCount: () => 0,
  databaseTableRowCountWhereEquals: () => 0,
  databaseTextValue: () => null,
}))

const mod = await import(u(join(repoRoot, 'src', 'utils', 'bannerlord-entity-resolver.ts')))
const policyMod = await import(u(join(repoRoot, 'src', 'utils', 'bannerlord-policy-id.ts')))

// normalizeReference and the policy normaliser are pure: no database needed.
const pureCases = []
const refInputs = [
  'Culture.vlandia', 'Faction.clan_x', 'Kingdom.vlandia', 'Settlement.town_V1',
  'Hero.lord_1', 'NPCCharacter.lord_1', 'Policy.policy_other',
  'Faction.Kingdom.vlandia', 'Kingdom.Faction.x', '', 'Culture.', 'Culture.vlandia.extra',
  'vlandia', 'X', 'Faction.',
]
for (const value of refInputs) {
  pureCases.push({
    kind: 'normalizeReference',
    input: value,
    prefixes: ['Culture.', 'Faction.', 'Kingdom.', 'Settlement.', 'Hero.', 'NPCCharacter.'],
    result: mod.normalizeReference(value, ['Culture.', 'Faction.', 'Kingdom.', 'Settlement.', 'Hero.', 'NPCCharacter.']),
  })
}
// The prefix ORDER matters, so the same value is also run against a reordered list.
pureCases.push({
  kind: 'normalizeReference',
  input: 'Faction.Kingdom.vlandia',
  prefixes: ['Kingdom.', 'Faction.'],
  result: mod.normalizeReference('Faction.Kingdom.vlandia', ['Kingdom.', 'Faction.']),
})
pureCases.push({
  kind: 'normalizeReference',
  input: 'Kingdom.Faction.vlandia',
  prefixes: ['Faction.', 'Kingdom.'],
  result: mod.normalizeReference('Kingdom.Faction.vlandia', ['Faction.', 'Kingdom.']),
})

const policyInputs = [
  'policy_land_grants_for_veterans', 'Policy.policy_land_grants_for_veterans',
  'POLICY.LAND_GRANTS', 'policy_land_grands_for_veteran', 'POLICY.policy_land_grands_for_veteran',
  '  spaced  ', 'Policy.', 'policy.', '.', '', 'Policy_Foo', 'policy.foo',
  'POLICY_other', 'policy_land_grants_for_veterans '.trim(),
  // ★ MEASURED EDGES. The first four pin the whitespace SET (JS trim removes U+FEFF, which Go's
  // TrimSpace does not; Go's TrimSpace removes U+0085, which JS does not). The last two pin FULL
  // case mapping: U+0130 is the single code point where JavaScript's toLowerCase and Go's ToLower
  // disagree, and because the result is compared against the alias table the difference is
  // observable here.
  '﻿policy_other', 'policy_other﻿', 'policy_other', 'policy_other',
  'POLİCY_LAND_GRANDS_FOR_VETERAN', 'İ',
]
for (const value of policyInputs) {
  pureCases.push({ kind: 'policyId', input: value, result: policyMod.normalizeBannerlordPolicyId(value) })
}

// The lookups, one case per branch the ORDER BY can take.
const lookupCases = []
const lookups = [
  ['lookupCultureName', 'Culture.vlandia'],
  ['lookupCultureName', 'Culture.empire'],
  ['lookupCultureName', 'Culture.missing'],
  ['lookupCultureName', null],
  ['lookupHeroName', 'Hero.lord_1'],
  ['lookupHeroName', 'NPCCharacter.lord_1'],
  ['lookupHeroName', 'Hero.nameless'],
  ['lookupHeroName', 'Hero.missing'],
  ['lookupClanInfo', 'Faction.clan_x'],
  ['lookupClanInfo', 'Clan.clan_x'],
  ['lookupClanInfo', 'Faction.clan_minor_only'],
  ['lookupClanInfo', 'Faction.missing'],
  ['lookupKingdomInfo', 'Faction.vlandia'],
  ['lookupKingdomInfo', 'Kingdom.vlandia'],
  ['lookupKingdomInfo', 'Kingdom.missing'],
  ['lookupPolicyName', 'policy_land_grants_for_veterans'],
  ['lookupPolicyName', 'Policy.policy_land_grants_for_veterans'],
  ['lookupPolicyName', 'policy_land_grands_for_veteran'],
  ['lookupPolicyName', 'policy_other'],
  ['lookupPolicyName', 'Unrelated.'],
  ['lookupPolicyName', 'policy.missing'],
  ['lookupSettlementInfo', 'Settlement.town_V1'],
  ['lookupSettlementInfo', 'Settlement.missing'],
]
for (const [fn, ref] of lookups) {
  let result, error
  try {
    result = mod[fn](db, ref)
  } catch (e) {
    error = String(e?.message ?? e)
  }
  lookupCases.push({ fn, reference: ref, result: result ?? null, error: error ?? null })
}

// formatReferenceLabel: the display-name branches, including a tokenised one (which needs the
// localization tables to exist, so this case is recorded as-is rather than assumed).
const labelCases = []
const labelInputs = [
  ['Hero.lord_1', 'Lord Aaa'],
  ['Hero.lord_1', null],
  [null, 'Some Name'],
  [null, null],
  ['', 'Some Name'],
  ['', ''],
  ['Hero.x', ''],
  // ★ THE CASE THAT CAUGHT THE PORT. An empty display name is FALSY in the TypeScript, so the
  // label falls back to the raw reference — while a port that was told "the lookup found a row"
  // took the name branch and produced `unknown [Hero.x]`.
  ['Hero.y', ''],
  ['Hero.z', null],
  ['Hero.token', '{=hero_name_fallback}Hero'],
]
for (const [raw, name] of labelInputs) {
  let result, error
  try {
    result = mod.formatReferenceLabel(raw, name)
  } catch (e) {
    error = String(e?.message ?? e)
  }
  labelCases.push({ raw, displayName: name, result: result ?? null, error: error ?? null })
}

const fixtures = {
  _comment:
    'GENERATED by gen_entityresolver_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/bannerlord-entity-resolver.ts and bannerlord-policy-id.ts against ' +
    'fixtures/entityresolver.db (six schemas copied from the real index, crafted rows). ' +
    'Do not edit by hand.',
  dbPath: 'tools/parity/fixtures/entityresolver.db',
  pureCases,
  lookupCases,
  labelCases,
}
writeFileSync(join(here, 'entityresolver_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote entityresolver_fixtures.json + fixtures/entityresolver.db')
console.log('  normalizeReference cases : ' + pureCases.filter(c => c.kind === 'normalizeReference').length)
console.log('  policyId cases           : ' + pureCases.filter(c => c.kind === 'policyId').length)
console.log('  lookup cases             : ' + lookupCases.length)
console.log('  label cases              : ' + labelCases.length)
console.log('')
const culture = lookupCases.find(c => c.reference === 'Culture.vlandia')
console.log('  ★ lookupCultureName(Culture.vlandia) -> ' + JSON.stringify(culture?.result))
console.log('    (two rows exist; the name-count DESC clause must pick Vlandia-B, whose filePath sorts LATER)')
const clan = lookupCases.find(c => c.reference === 'Faction.clan_x')
console.log('  ★ lookupClanInfo(Faction.clan_x) -> ' + JSON.stringify(clan?.result))
console.log('    (three rows exist; isNoble = 1 must win despite its later filePath)')
