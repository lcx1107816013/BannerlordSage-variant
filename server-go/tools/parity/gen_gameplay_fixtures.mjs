// Parity fixture generator for the ten gameplay getters (src/tools/get-*.ts) and the
// get_entity dispatcher.
//
// ── SAFETY, LEARNED THE HARD WAY (ledger F19) ────────────────────────────────────────────
// The module under test resolves its database from `BANNERSAGE_GAME`, so a generator that used
// the REAL game id would open — and in the store case DELETE — the live compiled index. That
// already happened once. Two defences here, both required:
//   1. A SYNTHETIC game id, whose directory cannot collide with a real one.
//   2. The fixture database is written ONLY under tools/parity/fixtures/, which is committed;
//      nothing touches dist/games/bannerlord/.
// The real database is opened exactly once, READ-ONLY, purely to copy table schemas.
//
// ── WHY A CRAFTED CORPUS AND NOT THE REAL ONE ────────────────────────────────────────────
// The real index cannot be committed (it is 600 MB, holds decompiled game source, and lives under
// a gitignored path). A crafted corpus can, and it lets the cases be chosen for what they PROVE:
// the localization token shapes, the null-vs-empty distinctions, the reference-label fallbacks,
// and the not-found early returns. Everything asserted is still produced by EXECUTING the real
// TypeScript against this corpus — the expectations are the tool's own output, not a rewrite of
// what it is assumed to do.
//
// Usage: bun run server-go/tools/parity/gen_gameplay_fixtures.mjs

import { Database } from 'bun:sqlite'
import { writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { removeOwnFixtureOrRefuse, markAsFixture } from './fixture_guard.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')

const REAL_DB = join(repoRoot, 'dist', 'games', 'bannerlord', 'bannerlord.db')
if (!existsSync(REAL_DB)) {
    console.error(`REFUSING TO RUN: the real index is needed only to copy table schemas, and it is absent at ${REAL_DB}`)
    process.exit(3)
}

const gameId = 'bannerlord-fixture-gameplay'
const fixtureDbDir = join(here, 'fixtures')
mkdirSync(fixtureDbDir, { recursive: true })
const dbFile = 'gameplay.db'
const dbPath = join(fixtureDbDir, dbFile)

// The scratch directory the tool will resolve. Synthetic id => cannot be the real index. The
// guard refuses rather than deletes if something unexpected is already there.
const resolveDir = join(repoRoot, 'dist', 'games', gameId)
if (existsSync(resolveDir)) rmSync(resolveDir, { recursive: true })
mkdirSync(resolveDir, { recursive: true })
const resolvePath = join(resolveDir, `${gameId}.db`)
removeOwnFixtureOrRefuse(resolvePath, 'gen_gameplay_fixtures.mjs')
removeOwnFixtureOrRefuse(dbPath, 'gen_gameplay_fixtures.mjs')

process.env.BANNERSAGE_GAME = gameId

// ── copy the real schemas, read-only ────────────────────────────────────────
const TABLES = [
    'bannerlord_heroes',
    'bannerlord_troops',
    'bannerlord_skills',
    'bannerlord_cultures',
    'bannerlord_clans',
    'bannerlord_kingdoms',
    'bannerlord_policies',
    'bannerlord_perks',
    'bannerlord_items',
    'bannerlord_settlements',
    'localization_entries',
    'source_localization_entries',
]

const real = new Database(REAL_DB, { readonly: true })
const schemas = []
for (const t of TABLES) {
    const row = real.query(`SELECT sql FROM sqlite_master WHERE type='table' AND name = $n`).get({ $n: t })
    if (!row) {
        console.error(`table ${t} is absent from the real index; the fixture would be incomplete`)
        process.exit(3)
    }
    schemas.push(row.sql)
}
const indexes = real
    .query(`SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL AND tbl_name IN (${TABLES.map(() => '?').join(',')})`)
    .all(...TABLES)
    .map(r => r.sql)
real.close()

rmSync(resolvePath, { force: true })
const db = new Database(resolvePath, { create: true })
markAsFixture(db, 'gen_gameplay_fixtures.mjs')
for (const sql of schemas) db.run(sql)
for (const sql of indexes) {
    try {
        db.run(sql)
    } catch {
        // An index on a table whose columns we copied verbatim should exist, but a partial
        // index expression may not survive; ignoring is safe because no query depends on it.
    }
}

// ── the crafted corpus ──────────────────────────────────────────────────────
const ins = t => {
    const cols = db.query(`PRAGMA table_info(${t})`).all().map(r => r.name)
    const placeholders = cols.map(() => '?').join(',')
    return {
        cols,
        run: obj => db.run(`INSERT INTO ${t} (${cols.map(c => `"${c}"`).join(',')}) VALUES (${placeholders})`,
            cols.map(c => (obj[c] === undefined ? null : obj[c]))),
    }
}

// ═══ cultures ═══
const culture = ins('bannerlord_cultures')
// Two rows for the SAME id, to exercise the ORDER BY that prefers the richer name list.
culture.run({
    cultureId: 'empire', filePath: 'Modules/A/cultures.xml', name: '{=cul_empire}Empire',
    descriptionText: '{=cul_empire_desc}The Empire', isMainCulture: 1, color: '0xFF00FF', color2: '0x123456',
    basicTroop: 'imperial_recruit', eliteBasicTroop: 'imperial_veteran', canHaveSettlement: 'true',
    boardGameType: 'Puluc', maleNameCount: 5, femaleNameCount: 5,
    defaultPolicyIdsJson: '["policy_feudal_inheritance","policy_land_grants_for_veterans"]', defaultPolicyCount: 2,
})
culture.run({
    cultureId: 'empire', filePath: 'Modules/B/cultures.xml', name: 'Less Complete',
    descriptionText: null, isMainCulture: 0, color: '0x000000', color2: null,
    basicTroop: null, eliteBasicTroop: null, canHaveSettlement: 'false', boardGameType: null,
    maleNameCount: 1, femaleNameCount: 1, defaultPolicyIdsJson: '[]', defaultPolicyCount: 0,
})
// A culture with NO description and a null name list, to pin the SQL ORDER tie-break.
culture.run({
    cultureId: 'quiet', filePath: 'Modules/C/cultures.xml', name: null, descriptionText: null,
    isMainCulture: 0, color: null, color2: null, basicTroop: null, eliteBasicTroop: null,
    canHaveSettlement: 'false', boardGameType: null, maleNameCount: 0, femaleNameCount: 0,
    defaultPolicyIdsJson: 'not json at all', defaultPolicyCount: 0,
})

// ═══ troops (also the source of hero display names) ═══
const troop = ins('bannerlord_troops')
troop.run({
    characterId: 'h_alive', filePath: 'Modules/T/troops.xml', name: '{=h_alive}Alive Hero', level: 20,
    culture: 'Culture.empire', occupation: 'Lord', skillTemplate: 'template_a', isHero: 1, isFemale: 0,
    upgradeTargetsJson: '[]',
})
troop.run({
    characterId: 'h_dead', filePath: 'Modules/T/troops.xml', name: '{=h_dead}Dead Hero', level: 10,
    culture: 'Culture.empire', occupation: 'Soldier', skillTemplate: null, isHero: 1, isFemale: 1,
    upgradeTargetsJson: '[]',
})
troop.run({
    characterId: 'h_template', filePath: 'Modules/T/troops.xml', name: 'Template Hero', level: 1,
    culture: null, occupation: null, skillTemplate: null, isHero: 0, isFemale: 0, upgradeTargetsJson: '[]',
})

// ═══ heroes ═══
const hero = ins('bannerlord_heroes')
hero.run({
    heroId: 'h_alive', filePath: 'Modules/H/heroes.xml', faction: 'Faction.k_empire', clan: 'Clan.c_empire',
    spouse: 'h_dead', father: null, mother: 'h_missing', alive: null, isTemplate: 0,
    text: '{=h_alive_bio}Born in the north',
})
hero.run({
    heroId: 'h_dead', filePath: 'Modules/H/heroes.xml', faction: null, clan: null,
    spouse: null, father: null, mother: null, alive: 'false', isTemplate: 1, text: null,
})
// A hero whose troop row does NOT exist: every LEFT JOINed troop field must come back null.
hero.run({
    heroId: 'h_no_troop_row', filePath: 'Modules/H/heroes.xml', faction: null, clan: null,
    spouse: null, father: null, mother: null, alive: 'true', isTemplate: 0,
    text: 'Plain text, not a token',
})

// ═══ skills ═══
const skill = ins('bannerlord_skills')
skill.run({
    skillId: 'OneHanded', filePath: 'Modules/S/skills.xml', name: '{=sk_onehanded}One Handed',
    documentation: 'Docs for one handed', modifierCount: 2,
    modifiersJson: '[{"attribCode":"AgentHitPoints","modification":"Multiply","value":"1.01"},{"attribCode":null,"modification":"Add","value":null}]',
})
skill.run({
    skillId: 'Malformed', filePath: 'Modules/S/skills.xml', name: null, documentation: null,
    modifierCount: 9, modifiersJson: 'this is not json',
})
skill.run({
    skillId: 'NotArray', filePath: 'Modules/S/skills.xml', name: null, documentation: null,
    modifierCount: 0, modifiersJson: '{"not":"an array"}',
})

// ═══ kingdoms ═══
const kingdom = ins('bannerlord_kingdoms')
kingdom.run({
    kingdomId: 'k_empire', filePath: 'Modules/K/kingdoms.xml', name: '{=k_empire}The Empire',
    shortName: '{=k_empire_short}EMP', title: '{=k_empire_title}Emperor', rulerTitle: '{=k_ruler}Basileus',
    descriptionText: '{=k_empire_desc}A grand realm', culture: 'Culture.empire', owner: 'Hero.h_alive',
    initialHomeSettlement: 'Settlement.town_a', color: '0xAAAAAA', color2: '0xBBBBBB',
    primaryBannerColor: '0xCCCCCC', secondaryBannerColor: '0xDDDDDD', relationshipCount: 3,
    policyCount: 2, policyIdsJson: '["policy_feudal_inheritance","Policy.policy_land_grands_for_veteran"]',
})
// A kingdom with an empty short name, to pin the `shortName ? ... : null` guard: an EMPTY string
// is falsy in JavaScript, so it must render as null -> "unknown", not as an empty value.
kingdom.run({
    kingdomId: 'k_empty', filePath: 'Modules/K/kingdoms.xml', name: 'Plain Kingdom', shortName: '',
    title: '', rulerTitle: null, descriptionText: '', culture: null, owner: null,
    initialHomeSettlement: null, color: null, color2: null, primaryBannerColor: null,
    secondaryBannerColor: null, relationshipCount: 0, policyCount: 0, policyIdsJson: '[]',
})

// ═══ clans ═══
const clan = ins('bannerlord_clans')
clan.run({
    clanId: 'c_empire', filePath: 'Modules/C/clans.xml', name: '{=c_empire}House Empire',
    shortName: '{=c_empire_short}HE', descriptionText: '{=c_empire_desc}A noble house',
    culture: 'Culture.empire', owner: 'Hero.h_alive', initialHomeSettlement: 'Settlement.town_a',
    superFaction: 'Faction.k_empire', tier: 5, isNoble: 1, isMinorFaction: 0, isBandit: 0,
    isOutlaw: 0, isMafia: 0, isMercenary: 0, color: '0x111111', color2: null, templateCount: 4,
})
// One of each "kind" branch of describeClanKind.
const clanKinds = [
    ['c_minor_merc', 1, 1, 0, 0, 0],   // minor mercenary faction
    ['c_minor', 0, 1, 0, 0, 0],        // minor faction
    ['c_bandit', 0, 0, 1, 0, 0],       // bandit faction
    ['c_plain', 0, 0, 0, 0, 0],        // faction
    ['c_player', 0, 0, 0, 0, 0],       // player faction (by id)
]
for (const [id, noble, minor, bandit, outlaw, mafia] of clanKinds) {
    const merc = id === 'c_minor_merc' ? 1 : 0
    clan.run({
        clanId: id, filePath: 'Modules/C/clans.xml', name: `Clan ${id}`, shortName: null,
        descriptionText: null, culture: null, owner: null, initialHomeSettlement: null,
        superFaction: null, tier: 1, isNoble: noble, isMinorFaction: minor, isBandit: bandit,
        isOutlaw: outlaw, isMafia: mafia, isMercenary: merc, color: null, color2: null, templateCount: 0,
    })
}
// player_faction must be recognised by its ID alone.
clan.run({
    clanId: 'player_faction', filePath: 'Modules/C/clans.xml', name: 'Player Clan', shortName: null,
    descriptionText: null, culture: null, owner: null, initialHomeSettlement: null, superFaction: null,
    tier: 0, isNoble: 0, isMinorFaction: 0, isBandit: 0, isOutlaw: 0, isMafia: 0, isMercenary: 0,
    color: null, color2: null, templateCount: 0,
})

// ═══ policies ═══
const policy = ins('bannerlord_policies')
policy.run({
    policyId: 'policy_land_grants_for_veterans', rawPolicyId: 'Policy.policy_land_grands_for_veteran',
    filePath: 'Modules/P/policies.xml', sourceModule: 'Native', displayName: '{=pol_land}Land Grants',
    descriptionText: '{=pol_land_desc}Grants land', proposalText: '{=pol_land_prop}Proposal',
    effectsText: '{=pol_land_eff}Effects', rulerSupport: 1, lordsSupport: -1, commonsSupport: 0,
    activeKingdomIdsJson: '["k_empire","Faction.k_empty"]', defaultCultureIdsJson: '["Culture.empire"]',
    activeKingdomCount: 2, defaultCultureCount: 1,
})
policy.run({
    policyId: 'policy_feudal_inheritance', rawPolicyId: 'policy_feudal_inheritance',
    filePath: 'Modules/P/policies.xml',
    sourceModule: 'Native', displayName: null, descriptionText: null, proposalText: null, effectsText: null,
    rulerSupport: 0, lordsSupport: 0, commonsSupport: 0, activeKingdomIdsJson: 'not json',
    defaultCultureIdsJson: '[]', activeKingdomCount: 0, defaultCultureCount: 0,
})

// ═══ perks ═══
const perk = ins('bannerlord_perks')
perk.run({
    perkId: 'perk_a', filePath: 'Modules/Pe/perks.xml', sourceModule: 'Native', skillId: 'OneHanded',
    tierIndex: 1, requiredSkillValue: 25, alternativePerkId: 'perk_b', displayName: '{=perk_a}Perk A',
    primaryDescription: '{=perk_a_p}Primary A', primaryRole: 'Personal', primaryBonus: 0.1,
    primaryIncrementType: 'Add', primaryTroopUsageMask: 1, secondaryDescription: null,
    secondaryRole: null, secondaryBonus: null, secondaryIncrementType: null,
    secondaryTroopUsageMask: null, sourceOrder: 2,
})
perk.run({
    perkId: 'perk_b', filePath: 'Modules/Pe/perks.xml', sourceModule: 'Native', skillId: 'OneHanded',
    tierIndex: 1, requiredSkillValue: 25, alternativePerkId: null, displayName: 'Perk B plain',
    primaryDescription: null, primaryRole: null, primaryBonus: null, primaryIncrementType: null,
    primaryTroopUsageMask: null, secondaryDescription: '{=perk_b_s}Secondary B',
    secondaryRole: 'Party', secondaryBonus: 0.2, secondaryIncrementType: 'Multiply',
    secondaryTroopUsageMask: 2, sourceOrder: 1,
})
// references a perk id that does not exist, to pin the "no name -> raw id" branch
perk.run({
    perkId: 'perk_c', filePath: 'Modules/Pe/perks.xml', sourceModule: 'Native', skillId: null,
    tierIndex: 2, requiredSkillValue: 50, alternativePerkId: 'perk_missing', displayName: null,
    primaryDescription: null, primaryRole: null, primaryBonus: null, primaryIncrementType: null,
    primaryTroopUsageMask: null, secondaryDescription: null, secondaryRole: null, secondaryBonus: null,
    secondaryIncrementType: null, secondaryTroopUsageMask: null, sourceOrder: 3,
})

// ═══ items ═══
const item = ins('bannerlord_items')
item.run({
    entityId: 'sword_a', entityKind: 'item', filePath: 'Modules/I/items.xml', name: '{=item_sword}A Sword',
    itemType: 'OneHandedWeapon', weight: 1.5, value: 100, weaponLength: 90, swingDamage: 30,
    swingDamageType: 'Cut', thrustDamage: 20, thrustDamageType: 'Pierce', speedRating: 95,
    balanceOrHitPoints: null, headArmor: null, bodyArmor: null, legArmor: null, armArmor: null,
    horseChargeDamage: null, horseSpeed: null, horseManeuver: null, tier: 3, pieceType: null,
    length: null, materialCount: null,
})
item.run({
    entityId: 'sword_a', entityKind: 'crafting_piece', filePath: 'Modules/I/pieces.xml', name: 'A Blade',
    itemType: null, weight: 0.5, value: null, weaponLength: null, swingDamage: null,
    swingDamageType: null, thrustDamage: null, thrustDamageType: null, speedRating: null,
    balanceOrHitPoints: 50, headArmor: null, bodyArmor: null, legArmor: null, armArmor: null,
    horseChargeDamage: null, horseSpeed: null, horseManeuver: null, tier: null, pieceType: 'Blade',
    length: 80, materialCount: 2,
})

// ═══ settlements ═══
const settlement = ins('bannerlord_settlements')
settlement.run({
    settlementId: 'town_a', filePath: 'Modules/Se/settlements.xml', name: '{=set_town_a}Town A',
    descriptionText: '{=set_town_a_desc}A town', owner: 'Clan.c_empire', culture: 'Culture.empire',
    settlementType: 'town', componentId: 'comp_a', boundSettlement: null, villageType: null,
    prosperityOrHearth: 5000, positionX: 100, positionY: 200, sceneName: 'scene_a',
    locationCount: 4, buildingCount: 6,
})
// owner is NOT a clan -> the tool must derive the faction from the BOUND settlement's owner.
settlement.run({
    settlementId: 'village_a', filePath: 'Modules/Se/settlements.xml', name: 'Village A',
    descriptionText: null, owner: null, culture: null, settlementType: 'village',
    componentId: null, boundSettlement: 'town_a', villageType: 'Wheat', prosperityOrHearth: 100,
    positionX: null, positionY: null, sceneName: null, locationCount: 0, buildingCount: 0,
})
// a castle, and one with an unknown type, to exercise every branch of the type ORDER BY
settlement.run({
    settlementId: 'castle_a', filePath: 'Modules/Se/settlements.xml', name: 'Castle A',
    descriptionText: null, owner: 'Faction.k_empty', culture: null, settlementType: 'castle',
    componentId: null, boundSettlement: null, villageType: null, prosperityOrHearth: 300,
    positionX: 1, positionY: 2, sceneName: null, locationCount: 1, buildingCount: 1,
})
settlement.run({
    settlementId: 'odd_a', filePath: 'Modules/Se/settlements.xml', name: 'Odd A',
    descriptionText: null, owner: 'Hero.h_alive', culture: null, settlementType: 'hideout',
    componentId: null, boundSettlement: null, villageType: null, prosperityOrHearth: null,
    positionX: null, positionY: null, sceneName: null, locationCount: 0, buildingCount: 0,
})

// ═══ localization ═══
const loc = ins('localization_entries')
// An id with translations in several languages including a `std_` (English source) row and two
// rows sharing a language, to exercise the rank + tie-break ordering.
for (const [language, text, filePath] of [
    ['SP', 'Espada', 'Modules/Native/ModuleData/Languages/SP/std_x.xml'],
    ['CNs', '剑', 'Modules/Native/ModuleData/Languages/CNs/std_x.xml'],
    ['CNs', '剑（备用）', 'Modules/Native/ModuleData/Languages/CNs/zz_second.xml'],
    ['DE', 'Schwert', 'Modules/Native/ModuleData/Languages/DE/std_x.xml'],
    ['std_SandBox.xml', 'Sword (english source)', 'x'],
    ['JP', '剣', 'Modules/Native/ModuleData/Languages/JP/std_x.xml'],
    ['NoTranslation', 'should never win', 'x'],
]) {
    loc.run({ stringId: 'item_sword', language, text, filePath })
}
loc.run({ stringId: 'cul_empire', language: 'CNs', text: '帝国', filePath: 'f.xml' })
loc.run({ stringId: 'h_alive', language: 'CNs', text: '幸存的英雄', filePath: 'f.xml' })
// A token whose translation is ITSELF a token: exercises the recursion.
loc.run({ stringId: 'nested', language: 'CNs', text: '{=item_sword}Sword', filePath: 'f.xml' })

const srcLoc = ins('source_localization_entries')
srcLoc.run({
    stringId: 'item_sword', fallbackText: 'Sword from source', normalizedFallback: 'sword from source',
    rawLiteral: 'Sword from source', filePath: 'src/a.cs', moduleName: 'M',
    assemblyName: 'A', lineNumber: 10, columnNumber: 5, contextKind: 'literal', sourcePriority: 1,
})
srcLoc.run({
    stringId: 'item_sword', fallbackText: 'Second source', normalizedFallback: 'second source',
    rawLiteral: 'Second source', filePath: 'src/b.cs', moduleName: 'M',
    assemblyName: 'A', lineNumber: 20, columnNumber: 1, contextKind: 'literal', sourcePriority: 2,
})

db.close()

// ── run the real TypeScript ─────────────────────────────────────────────────
const sandboxDbMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'db.ts')).href)
void sandboxDbMod
const entityMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'get-entity.ts')).href)
const { getEntity } = entityMod

const cases = [
    // localization: the token shapes are the point here
    ['hero', 'h_alive'],
    ['hero', 'h_dead'],
    ['hero', 'h_no_troop_row'],
    ['hero', 'missing_hero'],
    ['skill', 'OneHanded'],
    ['skill', 'Malformed'],
    ['skill', 'NotArray'],
    ['skill', 'nope'],
    ['culture', 'empire'],
    ['culture', 'quiet'],
    ['culture', 'nope'],
    ['clan', 'c_empire'],
    ['clan', 'c_minor_merc'],
    ['clan', 'c_minor'],
    ['clan', 'c_bandit'],
    ['clan', 'c_plain'],
    ['clan', 'player_faction'],
    ['clan', 'nope'],
    ['kingdom', 'k_empire'],
    ['kingdom', 'k_empty'],
    ['kingdom', 'nope'],
    ['policy', 'policy_feudal_inheritance'],
    ['policy', 'Policy.policy_land_grands_for_veteran'],
    ['policy', 'POLICY.FEUDAL_INHERITANCE'],
    ['policy', 'nope'],
    ['perk', 'perk_a'],
    ['perk', 'perk_b'],
    ['perk', 'perk_c'],
    ['perk', 'PERK_A'],
    ['perk', 'nope'],
    ['item', 'sword_a'],
    ['item', 'nope'],
    ['settlement', 'town_a'],
    ['settlement', 'village_a'],
    ['settlement', 'castle_a'],
    ['settlement', 'odd_a'],
    ['settlement', 'nope'],
]

const results = []
for (const [kind, id] of cases) {
    let out
    try {
        const res = await getEntity(kind, id)
        out = { ok: true, text: res.content[0].text }
    } catch (error) {
        out = { ok: false, error: String(error?.message ?? error) }
    }
    results.push({ kind, id, ...out })
}

// The token resolution itself, which the getters exercise only indirectly.
const locMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'localization.ts')).href)
const resolverMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'bannerlord-entity-resolver.ts')).href)
const policyMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'bannerlord-policy-id.ts')).href)
const { parseLocalizationToken } = locMod
const { normalizeReference, formatReferenceLabel } = resolverMod
const { normalizeBannerlordPolicyId } = policyMod
const { getDb } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'db.ts')).href)
const liveDb = getDb()

const tokenCases = ['{=abc}Fallback', '{=abc}', 'no token', '', '{=}', 'mid{=abc}x', '{=a}one{=b}two', '  {=a}x  ']
const tokens = tokenCases.map(t => ({ input: t, result: parseLocalizationToken(t) }))

const refCases = []
for (const [value, prefixes] of [
    ['Culture.empire', ['Culture.']],
    ['Hero.h_alive', ['Hero.', 'NPCCharacter.']],
    ['NPCCharacter.h_alive', ['Hero.', 'NPCCharacter.']],
    ['Faction.k_empire', ['Faction.', 'Kingdom.']],
    ['Kingdom.k_empire', ['Faction.', 'Kingdom.']],
    ['Faction.Kingdom.x', ['Faction.', 'Kingdom.']],
    ['plain', ['Faction.']],
    // ★ These two pin that the prefix must be at the START. Without them, a port that searched
    // for the prefix ANYWHERE would pass every other case, because in all of them the prefix
    // happens to sit at position 0.
    ['X.Faction.Y', ['Faction.']],
    ['xFaction.y', ['Faction.']],
    ['Kingdom.Faction.z', ['Faction.', 'Kingdom.']],
    ['', ['Faction.']],
    [null, ['Faction.']],
]) {
    refCases.push({ value, prefixes, result: normalizeReference(value, prefixes) })
}

const labelCases = []
for (const [raw, name] of [
    ['Hero.h_alive', '{=h_alive}Alive Hero'],
    ['Hero.h_alive', null],
    [null, '{=h_alive}Alive Hero'],
    [null, null],
    ['raw_only', null],
    ['raw_only', ''],
    ['', 'Plain Name'],
    ['raw_with_unknown_name', ''],
]) {
    labelCases.push({ raw, name, result: formatReferenceLabel(raw, name) })
}

const policyIdCases = ['policy_feudal_inheritance', 'Policy.policy_land_grands_for_veteran', 'POLICY.Foo', 'policy.foo', 'Policy.', '  spaced  ', '.', ''].map(v => ({
    input: v,
    result: normalizeBannerlordPolicyId(v),
}))

// Localization resolution over the crafted corpus, including preferred-language ordering.
const resolved = []
for (const [token, preferred] of [
    ['{=item_sword}Sword', undefined],
    ['{=item_sword}Sword', ['DE']],
    ['{=item_sword}Sword', ['SP']],
    ['{=item_sword}Sword', ['xx-unknown', 'JP']],
    ['{=nested}Nested', undefined],
    ['{=missing_token}Fallback', undefined],
    ['item_sword', undefined],
    ['==item_sword{', undefined],
    ['plain text', undefined],
    ['', undefined],
]) {
    resolved.push({
        token,
        preferred,
        result: locMod.resolveMaybeLocalizedText(token, preferred),
        details: locMod.resolveLocalizationDetails(token, preferred),
        map: locMod.resolveLocalizationMap(token, preferred),
    })
}

const fixtures = {
    _comment:
        'GENERATED by gen_gameplay_fixtures.mjs. Expected values come from EXECUTING the real ' +
        'src/tools/get-*.ts and src/utils/{localization,entity-resolver,policy-id}.ts against a ' +
        'crafted corpus in fixtures/gameplay.db. Do not edit by hand.',
    fixtureGameId: gameId,
    dbPath: `tools/parity/fixtures/${dbFile}`,
    entityCases: results,
    tokenCases: tokens,
    referenceCases: refCases,
    labelCases,
    policyIdCases,
    resolvedCases: resolved,
}

liveDb.close()
copyFileSync(resolvePath, dbPath)
writeFileSync(join(here, 'gameplay_fixtures.json'), JSON.stringify(fixtures, null, 2) + '\n', 'utf8')

console.log('wrote gameplay_fixtures.json + fixtures/gameplay.db')
console.log(`  entity cases   : ${results.length} (${results.filter(r => r.ok).length} rendered)`)
console.log(`  token cases    : ${tokens.length}`)
console.log(`  reference cases: ${refCases.length}`)
console.log(`  label cases    : ${labelCases.length}`)
console.log(`  policy id cases: ${policyIdCases.length}`)
console.log(`  resolved cases : ${resolved.length}`)
console.log()
console.log('  ★ a localized display name, which must carry the token:')
const h = results.find(r => r.kind === 'hero' && r.id === 'h_alive')
if (h?.ok) for (const l of h.text.split('\n').slice(0, 10)) console.log('      ' + l)
console.log()
console.log('  ★ a not-found early return:')
const nf = results.find(r => r.kind === 'hero' && r.id === 'missing_hero')
console.log('      ' + (nf?.text ?? nf?.error))
