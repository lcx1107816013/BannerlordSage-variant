import { Database } from 'bun:sqlite'
import { Glob } from 'bun'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'path'
import { normalizeBannerlordPolicyId } from '../utils/bannerlord-policy-id'
import { parser, readXmlTextFile } from '../utils/xml-utils'
import { getGamePaths } from '../utils/env'

/**
 * XML index: scans the game's Modules tree for `.xml` files and folds each
 * document into an incremental SQLite store — FTS over full document text,
 * entity nodes, localization entries, and per-domain projections (items,
 * troops, heroes, cultures, skills, clans, kingdoms, settlements).
 *
 * Only files whose size or mtime changed are re-parsed; removed files have
 * their rows deleted. Parse failures are recorded per file and rendered
 * into JSON + Markdown reports alongside the database.
 */

type XmlEntityRow = {
  entityType: string
  entityId: string
  name: string | null
  filePath: string
}

type LocalizationRow = {
  language: string
  stringId: string
  text: string
  filePath: string
}

type BannerlordItemProjectionRow = {
  entityId: string
  entityKind: 'Item' | 'CraftingPiece'
  filePath: string
  name: string | null
  itemType: string | null
  weight: string | null
  value: string | null
  weaponLength: string | null
  swingDamage: string | null
  swingDamageType: string | null
  thrustDamage: string | null
  thrustDamageType: string | null
  speedRating: string | null
  balanceOrHitPoints: string | null
  headArmor: string | null
  bodyArmor: string | null
  legArmor: string | null
  armArmor: string | null
  horseChargeDamage: string | null
  horseSpeed: string | null
  horseManeuver: string | null
  tier: string | null
  pieceType: string | null
  length: string | null
  materialCount: number | null
}

type BannerlordTroopProjectionRow = {
  characterId: string
  filePath: string
  name: string | null
  level: string | null
  culture: string | null
  occupation: string | null
  skillTemplate: string | null
  isHero: number
  isFemale: number
  upgradeTargetsJson: string
}

type BannerlordHeroProjectionRow = {
  heroId: string
  filePath: string
  faction: string | null
  clan: string | null
  spouse: string | null
  father: string | null
  mother: string | null
  alive: string | null
  isTemplate: number
  text: string | null
}

type BannerlordCultureProjectionRow = {
  cultureId: string
  filePath: string
  name: string | null
  descriptionText: string | null
  isMainCulture: number
  color: string | null
  color2: string | null
  basicTroop: string | null
  eliteBasicTroop: string | null
  canHaveSettlement: string | null
  boardGameType: string | null
  maleNameCount: number
  femaleNameCount: number
  defaultPolicyIdsJson: string
  defaultPolicyCount: number
}

type BannerlordSkillProjectionRow = {
  skillId: string
  filePath: string
  name: string | null
  documentation: string | null
  modifierCount: number
  modifiersJson: string
}

type BannerlordClanProjectionRow = {
  clanId: string
  filePath: string
  name: string | null
  shortName: string | null
  descriptionText: string | null
  culture: string | null
  owner: string | null
  initialHomeSettlement: string | null
  superFaction: string | null
  tier: string | null
  isNoble: number
  isMinorFaction: number
  isBandit: number
  isOutlaw: number
  isMafia: number
  isMercenary: number
  color: string | null
  color2: string | null
  templateCount: number
}

type BannerlordKingdomProjectionRow = {
  kingdomId: string
  filePath: string
  name: string | null
  shortName: string | null
  title: string | null
  rulerTitle: string | null
  descriptionText: string | null
  culture: string | null
  owner: string | null
  initialHomeSettlement: string | null
  color: string | null
  color2: string | null
  primaryBannerColor: string | null
  secondaryBannerColor: string | null
  relationshipCount: number
  policyCount: number
  policyIdsJson: string
}

type BannerlordSettlementProjectionRow = {
  settlementId: string
  filePath: string
  name: string | null
  descriptionText: string | null
  owner: string | null
  culture: string | null
  settlementType: string | null
  componentId: string | null
  boundSettlement: string | null
  villageType: string | null
  prosperityOrHearth: string | null
  positionX: string | null
  positionY: string | null
  sceneName: string | null
  locationCount: number
  buildingCount: number
}

type XmlParseFailure = {
  filePath: string
  moduleName: string
  category: string
  errorName: string
  message: string
}

type XmlDocumentRow = {
  moduleName: string
  filePath: string
  content: string
  parseFailure: XmlParseFailure | null
  entities: XmlEntityRow[]
  localizations: LocalizationRow[]
  itemProjections: BannerlordItemProjectionRow[]
  troopProjections: BannerlordTroopProjectionRow[]
  heroProjections: BannerlordHeroProjectionRow[]
  cultureProjections: BannerlordCultureProjectionRow[]
  skillProjections: BannerlordSkillProjectionRow[]
  clanProjections: BannerlordClanProjectionRow[]
  kingdomProjections: BannerlordKingdomProjectionRow[]
  settlementProjections: BannerlordSettlementProjectionRow[]
}

type XmlSourceFileSnapshot = {
  relativePath: string
  absolutePath: string
  size: number
  mtimeMs: number
}

type IndexedXmlFileRow = {
  filePath: string
  fileSize: number
  fileMtimeMs: number
}

const XML_INSERT_BATCH_SIZE = 200
const XML_INDEX_SCHEMA_VERSION = '2'
const PARSE_FAILURE_PREVIEW_COUNT = 10

type XmlIndexSummary = {
  filesIndexed: number
  entitiesIndexed: number
  localizationsIndexed: number
  parseFailures: number
  duplicateFilesSkipped: number
}

export async function buildXmlIndex(gameId?: string): Promise<XmlIndexSummary> {
  const { defsPath, dbPath, reportsPath, xmlParseReportPath, xmlParseReportMarkdownPath, gameId: resolvedGameId } =
    getGamePaths(gameId)
  console.log(`Building XML index from ${defsPath}`)

  const db = new Database(dbPath)

  try {
    db.run('PRAGMA busy_timeout = 5000;')
    db.run('PRAGMA journal_mode = WAL;')

    if (!hasXmlIncrementalSchema(db)) {
      resetXmlSchema(db)
    } else {
      ensureXmlSchema(db)
    }

    const { files: sourceFiles, duplicateFilesSkipped } = await collectXmlSourceFiles(defsPath)
    const previouslyIndexed = loadIndexedXmlFiles(db)
    const changedFiles = sourceFiles.filter(file => {
      const previous = previouslyIndexed.get(file.relativePath)
      return !previous || previous.fileSize !== file.size || previous.fileMtimeMs !== file.mtimeMs
    })
    const currentPaths = new Set(sourceFiles.map(file => file.relativePath))
    const stalePaths = [...previouslyIndexed.keys()].filter(path => !currentPaths.has(path))

    const statements = prepareXmlInsertStatements(db)
    const wipeFile = (filePath: string) => {
      deleteFtsByPath(db, filePath)
      for (const table of XML_PROJECTION_TABLES) {
        statements.deleteByFile[table].run({ $filePath: filePath })
      }
      statements.deleteParseFailureByFile.run({ $filePath: filePath })
    }

    if (stalePaths.length > 0) {
      const purgeStale = db.transaction((paths: string[]) => {
        for (const path of paths) {
          wipeFile(path)
          statements.deleteTrackedFile.run({ $filePath: path })
        }
      })
      purgeStale(stalePaths)
    }

    const scanTotals = { entities: 0, localizations: 0 }
    const ingestBatch = db.transaction((rows: XmlDocumentRow[]) => {
      const touchedPaths = [...new Set(rows.map(row => row.filePath))]
      for (const filePath of touchedPaths) {
        wipeFile(filePath)
      }

      const snapshotsByPath = new Map(changedFiles.map(file => [file.relativePath, file]))
      const indexedAt = new Date().toISOString()

      for (const row of rows) {
        applyXmlRow(row, statements)

        const snapshot = snapshotsByPath.get(row.filePath)
        if (snapshot) {
          statements.upsertTrackedFile.run({
            $filePath: snapshot.relativePath,
            $fileSize: snapshot.size,
            $fileMtimeMs: snapshot.mtimeMs,
            $indexedAt,
          })
        }
      }
    })

    const batch: XmlDocumentRow[] = []
    for (const file of changedFiles) {
      const row = await buildXmlDocumentRow(file)
      batch.push(row)
      scanTotals.entities += row.entities.length
      scanTotals.localizations += row.localizations.length

      if (batch.length >= XML_INSERT_BATCH_SIZE) {
        ingestBatch(batch)
        batch.length = 0
      }
    }
    if (batch.length > 0) {
      ingestBatch(batch)
      batch.length = 0
    }

    const failures = loadAllXmlParseFailures(db)
    const entityCount = countRows(db, 'xml_entities')
    const localizationCount = countRows(db, 'localization_entries')

    await writeXmlParseReports(resolvedGameId, reportsPath, xmlParseReportPath, xmlParseReportMarkdownPath, sourceFiles.length, failures)

    if (changedFiles.length === 0 && stalePaths.length === 0) {
      console.log('No XML changes detected. Skipping rebuild.')
    } else {
      console.log(`Indexed ${changedFiles.length} changed XML files and removed ${stalePaths.length} stale files.`)
      console.log(
        `This run scanned ${scanTotals.entities} entity nodes and ${scanTotals.localizations} XML localization entries from changed files.`
      )
    }
    printIndexSummary(sourceFiles.length, entityCount, localizationCount, duplicateFilesSkipped, failures, xmlParseReportPath, xmlParseReportMarkdownPath)

    return {
      filesIndexed: sourceFiles.length,
      entitiesIndexed: entityCount,
      localizationsIndexed: localizationCount,
      parseFailures: failures.length,
      duplicateFilesSkipped,
    }
  } finally {
    db.close()
  }
}

const XML_PROJECTION_TABLES = [
  'xml_entities',
  'localization_entries',
  'bannerlord_items',
  'bannerlord_troops',
  'bannerlord_heroes',
  'bannerlord_cultures',
  'bannerlord_skills',
  'bannerlord_clans',
  'bannerlord_kingdoms',
  'bannerlord_settlements',
] as const

function deleteFtsByPath(db: Database, filePath: string): void {
  db.prepare(`DELETE FROM xml_documents_fts WHERE filePath = $filePath`).run({ $filePath: filePath })
}

/** Shared tail of both index runs: totals, dedupe note, parse-failure digest. */
function printIndexSummary(
  filesIndexed: number,
  entityCount: number,
  localizationCount: number,
  duplicateFilesSkipped: number,
  failures: XmlParseFailure[],
  xmlParseReportPath: string,
  xmlParseReportMarkdownPath: string
): void {
  console.log(
    `Active XML state: ${filesIndexed} files, ${entityCount} entity nodes, and ${localizationCount} XML localization entries.`
  )
  if (duplicateFilesSkipped > 0) {
    console.log(`Duplicate XML paths skipped during indexing: ${duplicateFilesSkipped}`)
  }
  console.log(`XML parse failures recorded: ${failures.length}`)
  console.log(`XML parse report: ${xmlParseReportPath}`)
  if (failures.length > 0) {
    console.warn(`XML parse summary: ${failures.length} files could not be parsed cleanly.`)
    for (const failure of failures.slice(0, PARSE_FAILURE_PREVIEW_COUNT)) {
      console.warn(`- ${failure.filePath} [${failure.category}] ${failure.message}`)
    }
    if (failures.length > PARSE_FAILURE_PREVIEW_COUNT) {
      console.warn(`- ... ${failures.length - PARSE_FAILURE_PREVIEW_COUNT} more. See ${xmlParseReportMarkdownPath}`)
    }
  }
}

// ── XML tree walkers ────────────────────────────────────────────────────────
// Each walker recurses the parsed object graph and projects the nodes whose
// tag matches its domain. fast-xml-parser keeps attributes as `@_key` keys
// and repeats elements as arrays, so every walker handles both shapes.

function forEachNode(node: unknown, visit: (record: Record<string, unknown>, tag: string) => void, tag = 'root'): void {
  if (!node || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const child of node) {
      forEachNode(child, visit, tag)
    }
    return
  }

  const record = node as Record<string, unknown>
  visit(record, tag)

  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('@_')) continue
    forEachNode(value, visit, key)
  }
}

function collectXmlEntities(node: unknown, filePath: string, target: XmlEntityRow[], currentTag = 'root'): void {
  forEachNode(node, (record, tag) => {
    const entityId = typeof record['@_id'] === 'string' ? record['@_id'] : null
    if (entityId) {
      target.push({
        entityType: tag,
        entityId,
        name: getBestEntityName(record),
        filePath,
      })
    }
  }, currentTag)
}

/** First present attribute among the usual display-attribute suspects. */
function getBestEntityName(record: Record<string, unknown>): string | null {
  for (const key of ['@_name', '@_text', '@_value', '@_culture']) {
    if (typeof record[key] === 'string') {
      return record[key]
    }
  }
  return null
}

function collectLocalizations(
  node: unknown,
  filePath: string,
  target: LocalizationRow[],
  language = inferLanguageFromPath(filePath)
): void {
  if (!node || typeof node !== 'object') return

  if (Array.isArray(node)) {
    for (const child of node) {
      collectLocalizations(child, filePath, target, language)
    }
    return
  }

  const record = node as Record<string, unknown>
  const stringId = typeof record['@_id'] === 'string' ? record['@_id'] : null
  const text =
    (typeof record['@_text'] === 'string' && record['@_text']) ||
    (typeof record['@_value'] === 'string' && record['@_value']) ||
    null

  if (stringId && text && /\/Languages\//i.test(filePath)) {
    target.push({ language, stringId, text, filePath })
  }

  for (const value of Object.values(record)) {
    collectLocalizations(value, filePath, target, language)
  }
}

function collectByTag(
  node: unknown,
  tagNames: string[],
  push: (record: Record<string, any>, filePath: string) => void,
  filePath: string
): void {
  forEachNode(node, (record, tag) => {
    if (!tagNames.includes(tag)) return
    for (const candidate of toObjectArray(record)) {
      push(candidate, filePath)
    }
  })
  void filePath
}

function collectItemProjections(node: unknown, filePath: string, target: BannerlordItemProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag === 'Item') {
      for (const candidate of toObjectArray(record)) {
        pushItemProjection(candidate, filePath, target)
      }
    } else if (tag === 'CraftingPiece') {
      for (const candidate of toObjectArray(record)) {
        pushCraftingPieceProjection(candidate, filePath, target)
      }
    }
  })
}

function collectTroopProjections(node: unknown, filePath: string, target: BannerlordTroopProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'NPCCharacter') return
    for (const candidate of toObjectArray(record)) {
      pushTroopProjection(candidate, filePath, target)
    }
  })
}

function collectHeroProjections(node: unknown, filePath: string, target: BannerlordHeroProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'Hero') return
    for (const candidate of toObjectArray(record)) {
      pushHeroProjection(candidate, filePath, target)
    }
  })
}

function collectCultureProjections(node: unknown, filePath: string, target: BannerlordCultureProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'Culture') return
    for (const candidate of toObjectArray(record)) {
      pushCultureProjection(candidate, filePath, target)
    }
  })
}

function collectSkillProjections(node: unknown, filePath: string, target: BannerlordSkillProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'SkillData') return
    for (const candidate of toObjectArray(record)) {
      pushSkillProjection(candidate, filePath, target)
    }
  })
}

function collectClanProjections(node: unknown, filePath: string, target: BannerlordClanProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'Faction') return
    for (const candidate of toObjectArray(record)) {
      pushClanProjection(candidate, filePath, target)
    }
  })
}

function collectKingdomProjections(node: unknown, filePath: string, target: BannerlordKingdomProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'Kingdom') return
    for (const candidate of toObjectArray(record)) {
      pushKingdomProjection(candidate, filePath, target)
    }
  })
}

function collectSettlementProjections(node: unknown, filePath: string, target: BannerlordSettlementProjectionRow[]): void {
  forEachNode(node, (record, tag) => {
    if (tag !== 'Settlement') return
    for (const candidate of toObjectArray(record)) {
      pushSettlementProjection(candidate, filePath, target)
    }
  })
}

// ── Row builders ─────────────────────────────────────────────────────────────

function pushItemProjection(item: Record<string, any>, filePath: string, target: BannerlordItemProjectionRow[]): void {
  if (typeof item['@_id'] !== 'string') {
    return
  }

  const component = (item.ItemComponent ?? {}) as Record<string, any>
  const weapon = firstOf(component.Weapon)
  const armor = firstOf(component.Armor)
  const horse = firstOf(component.Horse)

  target.push({
    entityId: item['@_id'],
    entityKind: 'Item',
    filePath,
    name: typeof item['@_name'] === 'string' ? item['@_name'] : null,
    itemType: typeof item['@_Type'] === 'string' ? item['@_Type'] : null,
    weight: toOptionalText(item['@_weight']),
    value: toOptionalText(item['@_value']),
    weaponLength: toOptionalText(weapon?.['@_weapon_length']),
    swingDamage: toOptionalText(weapon?.['@_swing_damage']),
    swingDamageType: toOptionalText(weapon?.['@_swing_damage_type']),
    thrustDamage: toOptionalText(weapon?.['@_thrust_damage']),
    thrustDamageType: toOptionalText(weapon?.['@_thrust_damage_type']),
    speedRating: toOptionalText(weapon?.['@_speed_rating']),
    balanceOrHitPoints: toOptionalText(weapon?.['@_weapon_balance'] ?? weapon?.['@_hit_points']),
    headArmor: toOptionalText(armor?.['@_head_armor']),
    bodyArmor: toOptionalText(armor?.['@_body_armor']),
    legArmor: toOptionalText(armor?.['@_leg_armor']),
    armArmor: toOptionalText(armor?.['@_arm_armor']),
    horseChargeDamage: toOptionalText(horse?.['@_charge_damage']),
    horseSpeed: toOptionalText(horse?.['@_speed']),
    horseManeuver: toOptionalText(horse?.['@_maneuver']),
    tier: null,
    pieceType: null,
    length: null,
    materialCount: null,
  })
}

function pushCraftingPieceProjection(piece: Record<string, any>, filePath: string, target: BannerlordItemProjectionRow[]): void {
  if (typeof piece['@_id'] !== 'string') {
    return
  }

  const materials = piece.Materials?.Material
  const materialCount = Array.isArray(materials) ? materials.length : materials ? 1 : 0

  target.push({
    entityId: piece['@_id'],
    entityKind: 'CraftingPiece',
    filePath,
    name: typeof piece['@_name'] === 'string' ? piece['@_name'] : null,
    itemType: null,
    weight: toOptionalText(piece['@_weight']),
    value: null,
    weaponLength: null,
    swingDamage: null,
    swingDamageType: null,
    thrustDamage: null,
    thrustDamageType: null,
    speedRating: null,
    balanceOrHitPoints: null,
    headArmor: null,
    bodyArmor: null,
    legArmor: null,
    armArmor: null,
    horseChargeDamage: null,
    horseSpeed: null,
    horseManeuver: null,
    tier: toOptionalText(piece['@_tier']),
    pieceType: toOptionalText(piece['@_piece_type']),
    length: toOptionalText(piece['@_length']),
    materialCount,
  })
}

function pushTroopProjection(npcRecord: Record<string, any>, filePath: string, target: BannerlordTroopProjectionRow[]): void {
  if (typeof npcRecord['@_id'] !== 'string') {
    return
  }

  const rawTargets = npcRecord.upgrade_targets?.upgrade_target
  const upgradeTargets = toObjectArray(rawTargets)
    .map(item => item?.['@_id'])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  target.push({
    characterId: npcRecord['@_id'],
    filePath,
    name: typeof npcRecord['@_name'] === 'string' ? npcRecord['@_name'] : null,
    level: toOptionalText(npcRecord['@_level']),
    culture: toOptionalText(npcRecord['@_culture']),
    occupation: toOptionalText(npcRecord['@_occupation']),
    skillTemplate: toOptionalText(npcRecord['@_skill_template']),
    isHero: toBooleanNumber(npcRecord['@_is_hero']),
    isFemale: toBooleanNumber(npcRecord['@_is_female']),
    upgradeTargetsJson: JSON.stringify(upgradeTargets),
  })
}

function pushHeroProjection(heroRecord: Record<string, any>, filePath: string, target: BannerlordHeroProjectionRow[]): void {
  if (typeof heroRecord['@_id'] !== 'string') {
    return
  }

  target.push({
    heroId: heroRecord['@_id'],
    filePath,
    faction: toOptionalText(heroRecord['@_faction']),
    clan: toOptionalText(heroRecord['@_clan']),
    spouse: toOptionalText(heroRecord['@_spouse']),
    father: toOptionalText(heroRecord['@_father']),
    mother: toOptionalText(heroRecord['@_mother']),
    alive: toOptionalText(heroRecord['@_alive']),
    isTemplate: toBooleanNumber(heroRecord['@_is_template']),
    text: toOptionalText(heroRecord['@_text']),
  })
}

function pushCultureProjection(cultureRecord: Record<string, any>, filePath: string, target: BannerlordCultureProjectionRow[]): void {
  if (typeof cultureRecord['@_id'] !== 'string') {
    return
  }

  const defaultPolicies = toObjectArray(cultureRecord.default_policies?.policy)
    .map(policy => normalizeBannerlordPolicyId(toOptionalText(policy['@_id'])))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  target.push({
    cultureId: cultureRecord['@_id'],
    filePath,
    name: toOptionalText(cultureRecord['@_name']),
    descriptionText: toOptionalText(cultureRecord['@_text']),
    isMainCulture: toBooleanNumber(cultureRecord['@_is_main_culture']),
    color: toOptionalText(cultureRecord['@_color']),
    color2: toOptionalText(cultureRecord['@_color2']),
    basicTroop: toOptionalText(cultureRecord['@_basic_troop']),
    eliteBasicTroop: toOptionalText(cultureRecord['@_elite_basic_troop']),
    canHaveSettlement: toOptionalText(cultureRecord['@_can_have_settlement']),
    boardGameType: toOptionalText(cultureRecord['@_board_game_type']),
    maleNameCount: toObjectArray(cultureRecord.male_names?.name).length,
    femaleNameCount: toObjectArray(cultureRecord.female_names?.name).length,
    defaultPolicyIdsJson: JSON.stringify(defaultPolicies),
    defaultPolicyCount: defaultPolicies.length,
  })
}

function pushSkillProjection(skillRecord: Record<string, any>, filePath: string, target: BannerlordSkillProjectionRow[]): void {
  if (typeof skillRecord['@_id'] !== 'string') {
    return
  }

  const modifiers = toObjectArray(skillRecord.Modifiers?.AttributeModifier)

  target.push({
    skillId: skillRecord['@_id'],
    filePath,
    name: toOptionalText(skillRecord['@_Name']),
    documentation: extractSkillDocumentation(skillRecord.Documentation),
    modifierCount: modifiers.length,
    modifiersJson: JSON.stringify(
      modifiers.map(modifier => ({
        attribCode: toOptionalText(modifier['@_AttribCode']),
        modification: toOptionalText(modifier['@_Modification']),
        value: toOptionalText(modifier['@_Value']),
      }))
    ),
  })
}

function pushClanProjection(clanRecord: Record<string, any>, filePath: string, target: BannerlordClanProjectionRow[]): void {
  if (typeof clanRecord['@_id'] !== 'string') {
    return
  }

  target.push({
    clanId: clanRecord['@_id'],
    filePath,
    name: toOptionalText(clanRecord['@_name']),
    shortName: toOptionalText(clanRecord['@_short_name']),
    descriptionText: toOptionalText(clanRecord['@_text']),
    culture: toOptionalText(clanRecord['@_culture']),
    owner: toOptionalText(clanRecord['@_owner']),
    initialHomeSettlement: toOptionalText(clanRecord['@_initial_home_settlement']),
    superFaction: toOptionalText(clanRecord['@_super_faction']),
    tier: toOptionalText(clanRecord['@_tier']),
    isNoble: toBooleanNumber(clanRecord['@_is_noble']),
    isMinorFaction: toBooleanNumber(clanRecord['@_is_minor_faction']),
    isBandit: toBooleanNumber(clanRecord['@_is_bandit']),
    isOutlaw: toBooleanNumber(clanRecord['@_is_outlaw']),
    isMafia: toBooleanNumber(clanRecord['@_is_mafia']),
    isMercenary: toBooleanNumber(clanRecord['@_is_clan_type_mercenary'] ?? clanRecord['@_is_mercenary']),
    color: toOptionalText(clanRecord['@_color']),
    color2: toOptionalText(clanRecord['@_color2']),
    templateCount: toObjectArray(clanRecord.minor_faction_character_templates?.template).length,
  })
}

function pushKingdomProjection(kingdomRecord: Record<string, any>, filePath: string, target: BannerlordKingdomProjectionRow[]): void {
  if (typeof kingdomRecord['@_id'] !== 'string') {
    return
  }

  const policies = toObjectArray(kingdomRecord.policies?.policy)
    .map(policy => normalizeBannerlordPolicyId(toOptionalText(policy['@_id'])))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)

  target.push({
    kingdomId: kingdomRecord['@_id'],
    filePath,
    name: toOptionalText(kingdomRecord['@_name']),
    shortName: toOptionalText(kingdomRecord['@_short_name']),
    title: toOptionalText(kingdomRecord['@_title']),
    rulerTitle: toOptionalText(kingdomRecord['@_ruler_title']),
    descriptionText: toOptionalText(kingdomRecord['@_text']),
    culture: toOptionalText(kingdomRecord['@_culture']),
    owner: toOptionalText(kingdomRecord['@_owner']),
    initialHomeSettlement: toOptionalText(kingdomRecord['@_initial_home_settlement']),
    color: toOptionalText(kingdomRecord['@_color']),
    color2: toOptionalText(kingdomRecord['@_color2']),
    primaryBannerColor: toOptionalText(kingdomRecord['@_primary_banner_color']),
    secondaryBannerColor: toOptionalText(kingdomRecord['@_secondary_banner_color']),
    relationshipCount: toObjectArray(kingdomRecord.relationships?.relationship).length,
    policyCount: policies.length,
    policyIdsJson: JSON.stringify(policies),
  })
}

function pushSettlementProjection(settlementRecord: Record<string, any>, filePath: string, target: BannerlordSettlementProjectionRow[]): void {
  if (typeof settlementRecord['@_id'] !== 'string') {
    return
  }

  const component = inspectSettlementComponents(settlementRecord.Components)
  const locations = toObjectArray(settlementRecord.Locations?.Location)

  target.push({
    settlementId: settlementRecord['@_id'],
    filePath,
    name: toOptionalText(settlementRecord['@_name']),
    descriptionText: toOptionalText(settlementRecord['@_text']),
    owner: toOptionalText(settlementRecord['@_owner']),
    culture: toOptionalText(settlementRecord['@_culture']),
    settlementType: component.settlementType ?? toOptionalText(settlementRecord['@_type']),
    componentId: component.componentId,
    boundSettlement: component.boundSettlement,
    villageType: component.villageType,
    prosperityOrHearth: component.prosperityOrHearth,
    positionX: toOptionalText(settlementRecord['@_posX']),
    positionY: toOptionalText(settlementRecord['@_posY']),
    sceneName: pickSceneName(locations),
    locationCount: locations.length,
    buildingCount: component.buildingCount,
  })
}

// ── Value helpers ─────────────────────────────────────────────────────────────

/** Wraps a maybe-array XML value into an array of object records. */
function toObjectArray(value: unknown): Record<string, any>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, any> => Boolean(item) && typeof item === 'object')
  }

  if (value && typeof value === 'object') {
    return [value as Record<string, any>]
  }

  return []
}

/** First element when the value is an array, the value itself otherwise. */
function firstOf<T>(value: T | T[] | undefined | null): T | null {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null
  }
  return value ?? null
}

function inferLanguageFromPath(filePath: string): string {
  const parts = filePath.split('/')
  const languagesIndex = parts.findIndex(part => part.toLowerCase() === 'languages')
  if (languagesIndex !== -1 && parts[languagesIndex + 1]) {
    return parts[languagesIndex + 1]
  }
  return 'unknown'
}

function inferModuleName(filePath: string): string {
  const parts = filePath.split('/')
  const modulesIndex = parts.findIndex(part => part.toLowerCase() === 'modules')
  if (modulesIndex !== -1 && parts[modulesIndex + 1]) {
    return parts[modulesIndex + 1]
  }

  return parts[0] || 'unknown'
}

/** Keys each dedupe helper uses; first occurrence wins. */
function dedupeBy<T>(rows: T[], keyOf: (row: T) => string): T[] {
  const seen = new Set<string>()
  const result: T[] = []

  for (const row of rows) {
    const key = keyOf(row)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(row)
  }

  return result
}

const dedupeXmlEntities = (rows: XmlEntityRow[]) => dedupeBy(rows, row => `${row.entityType}@@${row.entityId}@@${row.filePath}`)
const dedupeLocalizations = (rows: LocalizationRow[]) => dedupeBy(rows, row => `${row.language}@@${row.stringId}@@${row.filePath}`)
const dedupeItemProjections = (rows: BannerlordItemProjectionRow[]) => dedupeBy(rows, row => `${row.entityId}@@${row.filePath}`)
const dedupeTroopProjections = (rows: BannerlordTroopProjectionRow[]) => dedupeBy(rows, row => `${row.characterId}@@${row.filePath}`)
const dedupeHeroProjections = (rows: BannerlordHeroProjectionRow[]) => dedupeBy(rows, row => `${row.heroId}@@${row.filePath}`)
const dedupeCultureProjections = (rows: BannerlordCultureProjectionRow[]) => dedupeBy(rows, row => `${row.cultureId}@@${row.filePath}`)
const dedupeSkillProjections = (rows: BannerlordSkillProjectionRow[]) => dedupeBy(rows, row => `${row.skillId}@@${row.filePath}`)
const dedupeClanProjections = (rows: BannerlordClanProjectionRow[]) => dedupeBy(rows, row => `${row.clanId}@@${row.filePath}`)
const dedupeKingdomProjections = (rows: BannerlordKingdomProjectionRow[]) => dedupeBy(rows, row => `${row.kingdomId}@@${row.filePath}`)
const dedupeSettlementProjections = (rows: BannerlordSettlementProjectionRow[]) => dedupeBy(rows, row => `${row.settlementId}@@${row.filePath}`)

function toOptionalText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value
  }

  if (typeof value === 'number') {
    return String(value)
  }

  return null
}

/** Booleans arrive as native booleans, `"true"/"1"` strings, or numbers. */
function toBooleanNumber(value: unknown): number {
  if (typeof value === 'boolean') {
    return value ? 1 : 0
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === '1' ? 1 : 0
  }

  if (typeof value === 'number') {
    return value !== 0 ? 1 : 0
  }

  return 0
}

type SettlementComponentInfo = {
  settlementType: string | null
  componentId: string | null
  boundSettlement: string | null
  villageType: string | null
  prosperityOrHearth: string | null
  buildingCount: number
}

/** Classifies a settlement by its first present component element. */
function inspectSettlementComponents(value: unknown): SettlementComponentInfo {
  const components = value && typeof value === 'object' ? (value as Record<string, unknown>) : null

  const village = components ? toObjectArray(components.Village)[0] : null
  if (village) {
    return {
      settlementType: 'village',
      componentId: toOptionalText(village['@_id']),
      boundSettlement: toOptionalText(village['@_bound']),
      villageType: toOptionalText(village['@_village_type']),
      prosperityOrHearth: toOptionalText(village['@_hearth']),
      buildingCount: 0,
    }
  }

  const town = components ? toObjectArray(components.Town)[0] : null
  if (town) {
    return {
      settlementType: toBooleanNumber(town['@_is_castle']) ? 'castle' : 'town',
      componentId: toOptionalText(town['@_id']),
      boundSettlement: null,
      villageType: null,
      prosperityOrHearth: toOptionalText(town['@_prosperity']),
      buildingCount: toObjectArray(town.Buildings?.Building).length,
    }
  }

  const hideout = components ? toObjectArray(components.Hideout)[0] : null
  if (hideout) {
    return {
      settlementType: 'hideout',
      componentId: toOptionalText(hideout['@_id']),
      boundSettlement: null,
      villageType: null,
      prosperityOrHearth: null,
      buildingCount: 0,
    }
  }

  const custom = components ? toObjectArray(components.CustomSettlementComponent)[0] : null
  if (custom) {
    return {
      settlementType: 'custom',
      componentId: toOptionalText(custom['@_id']),
      boundSettlement: null,
      villageType: null,
      prosperityOrHearth: null,
      buildingCount: 0,
    }
  }

  return {
    settlementType: null,
    componentId: null,
    boundSettlement: null,
    villageType: null,
    prosperityOrHearth: null,
    buildingCount: 0,
  }
}

function pickSceneName(locations: Record<string, any>[]): string | null {
  for (const location of locations) {
    const sceneName =
      toOptionalText(location['@_scene_name']) ??
      toOptionalText(location['@_scene_name_1']) ??
      toOptionalText(location['@_scene_name_2']) ??
      toOptionalText(location['@_scene_name_3'])

    if (sceneName) {
      return sceneName
    }
  }

  return null
}

function extractSkillDocumentation(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim() || null
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record['#text'] === 'string' && record['#text'].trim().length > 0) {
      return record['#text'].trim()
    }
  }

  return null
}

// ── Parse failures & reports ─────────────────────────────────────────────────

function buildParseFailure(filePath: string, moduleName: string, error: unknown): XmlParseFailure {
  return {
    filePath,
    moduleName,
    category: inferXmlCategory(filePath),
    errorName: error instanceof Error && error.name ? error.name : 'Error',
    message: error instanceof Error ? error.message.trim() : String(error).trim(),
  }
}

function inferXmlCategory(filePath: string): string {
  const normalized = filePath.toLowerCase()

  if (normalized.includes('/languages/')) return 'localization'
  if (normalized.includes('/gui/')) return 'ui'
  if (normalized.includes('/moduledata/')) return 'module-data'
  return 'other'
}

function renderParseReportMarkdown(gameId: string, filesIndexed: number, failures: XmlParseFailure[]): string {
  const lines = [
    '# XML Parse Report',
    '',
    `- Game: \`${gameId}\``,
    `- Generated: \`${new Date().toISOString()}\``,
    `- Files indexed: \`${filesIndexed}\``,
    `- Parse failures: \`${failures.length}\``,
    '',
  ]

  if (failures.length === 0) {
    lines.push('No XML parse failures were detected.')
    return lines.join('\n')
  }

  lines.push('## Failures', '')
  for (const failure of failures) {
    lines.push(`### ${failure.filePath}`)
    lines.push(`- Module: \`${failure.moduleName}\``)
    lines.push(`- Category: \`${failure.category}\``)
    lines.push(`- Error: \`${failure.errorName}\``)
    lines.push(`- Message: ${failure.message}`)
    lines.push('')
  }

  return lines.join('\n')
}

async function writeXmlParseReports(
  gameId: string,
  reportsPath: string,
  xmlParseReportPath: string,
  xmlParseReportMarkdownPath: string,
  filesIndexed: number,
  failures: XmlParseFailure[]
): Promise<void> {
  await mkdir(reportsPath, { recursive: true })
  await writeFile(
    xmlParseReportPath,
    JSON.stringify(
      {
        gameId,
        generatedAt: new Date().toISOString(),
        filesIndexed,
        parseFailureCount: failures.length,
        failures,
      },
      null,
      2
    ),
    'utf8'
  )
  await writeFile(xmlParseReportMarkdownPath, renderParseReportMarkdown(gameId, filesIndexed, failures), 'utf8')
}

// ── File discovery ───────────────────────────────────────────────────────────

async function collectXmlSourceFiles(defsPath: string): Promise<{
  files: XmlSourceFileSnapshot[]
  duplicateFilesSkipped: number
}> {
  const glob = new Glob('**/*.xml')
  const seenFilePaths = new Set<string>()
  const files: XmlSourceFileSnapshot[] = []
  let duplicateFilesSkipped = 0

  for await (const relativePath of glob.scan({ cwd: defsPath })) {
    const normalizedPath = relativePath.replaceAll('\\', '/')
    const dedupeKey = normalizedPath.toLowerCase()
    if (seenFilePaths.has(dedupeKey)) {
      duplicateFilesSkipped += 1
      continue
    }

    seenFilePaths.add(dedupeKey)
    const fullPath = join(defsPath, relativePath)
    const fileStats = await stat(fullPath)
    files.push({
      relativePath: normalizedPath,
      absolutePath: fullPath,
      size: fileStats.size,
      mtimeMs: fileStats.mtimeMs,
    })
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { files, duplicateFilesSkipped }
}

/** Parses one changed file into every row shape the schema needs. */
async function buildXmlDocumentRow(file: XmlSourceFileSnapshot): Promise<XmlDocumentRow> {
  const moduleName = inferModuleName(file.relativePath)
  const xmlText = await readXmlTextFile(file.absolutePath)

  const row: XmlDocumentRow = {
    moduleName,
    filePath: file.relativePath,
    content: xmlText,
    parseFailure: null,
    entities: [],
    localizations: [],
    itemProjections: [],
    troopProjections: [],
    heroProjections: [],
    cultureProjections: [],
    skillProjections: [],
    clanProjections: [],
    kingdomProjections: [],
    settlementProjections: [],
  }

  try {
    const xmlObj = parser.parse(xmlText)
    collectXmlEntities(xmlObj, file.relativePath, row.entities)
    collectLocalizations(xmlObj, file.relativePath, row.localizations)
    collectItemProjections(xmlObj, file.relativePath, row.itemProjections)
    collectTroopProjections(xmlObj, file.relativePath, row.troopProjections)
    collectHeroProjections(xmlObj, file.relativePath, row.heroProjections)
    collectCultureProjections(xmlObj, file.relativePath, row.cultureProjections)
    collectSkillProjections(xmlObj, file.relativePath, row.skillProjections)
    collectClanProjections(xmlObj, file.relativePath, row.clanProjections)
    collectKingdomProjections(xmlObj, file.relativePath, row.kingdomProjections)
    collectSettlementProjections(xmlObj, file.relativePath, row.settlementProjections)
  } catch (error) {
    row.parseFailure = buildParseFailure(file.relativePath, moduleName, error)
  }

  return row
}

// ── Schema & persistence ─────────────────────────────────────────────────────

function hasXmlIncrementalSchema(db: Database): boolean {
  const requiredTables = [
    'xml_index_meta',
    'xml_files',
    'xml_parse_failures',
    'xml_documents_fts',
    ...XML_PROJECTION_TABLES,
  ]
  return (
    requiredTables.every(table => tableExists(db, table)) &&
    readXmlIndexSchemaVersion(db) === XML_INDEX_SCHEMA_VERSION &&
    !tableHasColumn(db, 'xml_entities', 'content')
  )
}

function ensureXmlSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS xml_index_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `)

  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS xml_documents_fts USING fts5(
      filePath,
      moduleName,
      content,
      tokenize = 'unicode61',
      prefix = '2 3 4'
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS xml_entities (
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      name TEXT,
      filePath TEXT NOT NULL,
      PRIMARY KEY (entityType, entityId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS localization_entries (
      language TEXT NOT NULL,
      stringId TEXT NOT NULL,
      text TEXT NOT NULL,
      filePath TEXT NOT NULL,
      PRIMARY KEY (language, stringId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_items (
      entityId TEXT NOT NULL,
      entityKind TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      itemType TEXT,
      weight TEXT,
      value TEXT,
      weaponLength TEXT,
      swingDamage TEXT,
      swingDamageType TEXT,
      thrustDamage TEXT,
      thrustDamageType TEXT,
      speedRating TEXT,
      balanceOrHitPoints TEXT,
      headArmor TEXT,
      bodyArmor TEXT,
      legArmor TEXT,
      armArmor TEXT,
      horseChargeDamage TEXT,
      horseSpeed TEXT,
      horseManeuver TEXT,
      tier TEXT,
      pieceType TEXT,
      length TEXT,
      materialCount INTEGER,
      PRIMARY KEY (entityId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_troops (
      characterId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      level TEXT,
      culture TEXT,
      occupation TEXT,
      skillTemplate TEXT,
      isHero INTEGER NOT NULL,
      isFemale INTEGER NOT NULL,
      upgradeTargetsJson TEXT NOT NULL,
      PRIMARY KEY (characterId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_heroes (
      heroId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      faction TEXT,
      clan TEXT,
      spouse TEXT,
      father TEXT,
      mother TEXT,
      alive TEXT,
      isTemplate INTEGER NOT NULL,
      text TEXT,
      PRIMARY KEY (heroId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_cultures (
      cultureId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      descriptionText TEXT,
      isMainCulture INTEGER NOT NULL,
      color TEXT,
      color2 TEXT,
      basicTroop TEXT,
      eliteBasicTroop TEXT,
      canHaveSettlement TEXT,
      boardGameType TEXT,
      maleNameCount INTEGER NOT NULL,
      femaleNameCount INTEGER NOT NULL,
      defaultPolicyIdsJson TEXT NOT NULL,
      defaultPolicyCount INTEGER NOT NULL,
      PRIMARY KEY (cultureId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_skills (
      skillId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      documentation TEXT,
      modifierCount INTEGER NOT NULL,
      modifiersJson TEXT NOT NULL,
      PRIMARY KEY (skillId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_clans (
      clanId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      shortName TEXT,
      descriptionText TEXT,
      culture TEXT,
      owner TEXT,
      initialHomeSettlement TEXT,
      superFaction TEXT,
      tier TEXT,
      isNoble INTEGER NOT NULL,
      isMinorFaction INTEGER NOT NULL,
      isBandit INTEGER NOT NULL,
      isOutlaw INTEGER NOT NULL,
      isMafia INTEGER NOT NULL,
      isMercenary INTEGER NOT NULL,
      color TEXT,
      color2 TEXT,
      templateCount INTEGER NOT NULL,
      PRIMARY KEY (clanId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_kingdoms (
      kingdomId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      shortName TEXT,
      title TEXT,
      rulerTitle TEXT,
      descriptionText TEXT,
      culture TEXT,
      owner TEXT,
      initialHomeSettlement TEXT,
      color TEXT,
      color2 TEXT,
      primaryBannerColor TEXT,
      secondaryBannerColor TEXT,
      relationshipCount INTEGER NOT NULL,
      policyCount INTEGER NOT NULL,
      policyIdsJson TEXT NOT NULL,
      PRIMARY KEY (kingdomId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_settlements (
      settlementId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      name TEXT,
      descriptionText TEXT,
      owner TEXT,
      culture TEXT,
      settlementType TEXT,
      componentId TEXT,
      boundSettlement TEXT,
      villageType TEXT,
      prosperityOrHearth TEXT,
      positionX TEXT,
      positionY TEXT,
      sceneName TEXT,
      locationCount INTEGER NOT NULL,
      buildingCount INTEGER NOT NULL,
      PRIMARY KEY (settlementId, filePath)
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS xml_files (
      filePath TEXT PRIMARY KEY,
      fileSize INTEGER NOT NULL,
      fileMtimeMs REAL NOT NULL,
      indexedAt TEXT NOT NULL
    );
  `)

  db.run(`
    CREATE TABLE IF NOT EXISTS xml_parse_failures (
      filePath TEXT PRIMARY KEY,
      moduleName TEXT NOT NULL,
      category TEXT NOT NULL,
      errorName TEXT NOT NULL,
      message TEXT NOT NULL
    );
  `)

  db.run('CREATE INDEX IF NOT EXISTS xml_entities_entity_id_idx ON xml_entities(entityId);')
  db.run('CREATE INDEX IF NOT EXISTS xml_entities_entity_type_idx ON xml_entities(entityType);')
  db.run('CREATE INDEX IF NOT EXISTS xml_entities_type_id_idx ON xml_entities(entityType, entityId);')
  db.run('CREATE INDEX IF NOT EXISTS localization_entries_string_id_idx ON localization_entries(stringId);')
  db.run('CREATE INDEX IF NOT EXISTS localization_entries_id_language_idx ON localization_entries(stringId, language);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_items_entity_id_idx ON bannerlord_items(entityId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_troops_character_id_idx ON bannerlord_troops(characterId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_heroes_hero_id_idx ON bannerlord_heroes(heroId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_cultures_culture_id_idx ON bannerlord_cultures(cultureId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_skills_skill_id_idx ON bannerlord_skills(skillId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_clans_clan_id_idx ON bannerlord_clans(clanId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_kingdoms_kingdom_id_idx ON bannerlord_kingdoms(kingdomId);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_settlements_settlement_id_idx ON bannerlord_settlements(settlementId);')
  db.prepare(`
    INSERT INTO xml_index_meta (key, value)
    VALUES ('schemaVersion', $value)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run({ $value: XML_INDEX_SCHEMA_VERSION })
}

function resetXmlSchema(db: Database): void {
  for (const table of ['xml_index_meta', 'xml_documents_fts', 'xml_files', 'xml_parse_failures', ...XML_PROJECTION_TABLES]) {
    db.run(`DROP TABLE IF EXISTS ${table};`)
  }
  ensureXmlSchema(db)
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string } | null, { $tableName: string }>(
      `
      SELECT name
      FROM sqlite_master
      WHERE type IN ('table', 'virtual table') AND name = $tableName
      LIMIT 1
    `
    )
    .get({ $tableName: tableName })

  return Boolean(row)
}

function tableHasColumn(db: Database, tableName: string, columnName: string): boolean {
  try {
    const rows = db.query<{ name: string }, never>(`PRAGMA table_info("${tableName.replaceAll('"', '""')}")`).all()
    return rows.some(row => row.name === columnName)
  } catch {
    return false
  }
}

function countRows(db: Database, tableName: string): number {
  return Number(db.query<{ count: number }, never>(`SELECT COUNT(*) AS count FROM ${tableName}`).get()?.count || 0)
}

function readXmlIndexSchemaVersion(db: Database): string {
  if (!tableExists(db, 'xml_index_meta')) {
    return ''
  }

  const row = db
    .query<{ value: string } | null, never>(
      `
      SELECT value
      FROM xml_index_meta
      WHERE key = 'schemaVersion'
      LIMIT 1
    `
    )
    .get()

  return row?.value ?? ''
}

function loadIndexedXmlFiles(db: Database): Map<string, IndexedXmlFileRow> {
  const rows = db
    .query<IndexedXmlFileRow, never>(
      `
      SELECT filePath, fileSize, fileMtimeMs
      FROM xml_files
    `
    )
    .all()

  return new Map(rows.map(row => [row.filePath, row]))
}

function loadAllXmlParseFailures(db: Database): XmlParseFailure[] {
  return db
    .query<XmlParseFailure, never>(
      `
      SELECT filePath, moduleName, category, errorName, message
      FROM xml_parse_failures
      ORDER BY category, filePath
    `
    )
    .all()
}

function prepareXmlInsertStatements(db: Database) {
  const deleteByFile = Object.fromEntries(
    XML_PROJECTION_TABLES.map(table => [table, db.prepare(`DELETE FROM ${table} WHERE filePath = $filePath`)])
  ) as Record<(typeof XML_PROJECTION_TABLES)[number], ReturnType<Database['prepare']>>

  return {
    deleteByFile,
    deleteParseFailureByFile: db.prepare(`DELETE FROM xml_parse_failures WHERE filePath = $filePath`),
    deleteTrackedFile: db.prepare(`DELETE FROM xml_files WHERE filePath = $filePath`),
    upsertTrackedFile: db.prepare(`
      INSERT OR REPLACE INTO xml_files (filePath, fileSize, fileMtimeMs, indexedAt)
      VALUES ($filePath, $fileSize, $fileMtimeMs, $indexedAt)
    `),
    insertFts: db.prepare(`
      INSERT INTO xml_documents_fts (filePath, moduleName, content)
      VALUES ($filePath, $moduleName, $content)
    `),
    insertEntity: db.prepare(`
      INSERT OR IGNORE INTO xml_entities (entityType, entityId, name, filePath)
      VALUES ($entityType, $entityId, $name, $filePath)
    `),
    insertLocalization: db.prepare(`
      INSERT OR IGNORE INTO localization_entries (language, stringId, text, filePath)
      VALUES ($language, $stringId, $text, $filePath)
    `),
    insertItemProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_items (
        entityId, entityKind, filePath, name, itemType, weight, value,
        weaponLength, swingDamage, swingDamageType, thrustDamage, thrustDamageType,
        speedRating, balanceOrHitPoints, headArmor, bodyArmor, legArmor, armArmor,
        horseChargeDamage, horseSpeed, horseManeuver, tier, pieceType, length, materialCount
      ) VALUES (
        $entityId, $entityKind, $filePath, $name, $itemType, $weight, $value,
        $weaponLength, $swingDamage, $swingDamageType, $thrustDamage, $thrustDamageType,
        $speedRating, $balanceOrHitPoints, $headArmor, $bodyArmor, $legArmor, $armArmor,
        $horseChargeDamage, $horseSpeed, $horseManeuver, $tier, $pieceType, $length, $materialCount
      )
    `),
    insertTroopProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_troops (
        characterId, filePath, name, level, culture, occupation, skillTemplate, isHero, isFemale, upgradeTargetsJson
      ) VALUES (
        $characterId, $filePath, $name, $level, $culture, $occupation, $skillTemplate, $isHero, $isFemale, $upgradeTargetsJson
      )
    `),
    insertHeroProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_heroes (
        heroId, filePath, faction, clan, spouse, father, mother, alive, isTemplate, text
      ) VALUES (
        $heroId, $filePath, $faction, $clan, $spouse, $father, $mother, $alive, $isTemplate, $text
      )
    `),
    insertCultureProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_cultures (
        cultureId, filePath, name, descriptionText, isMainCulture, color, color2,
        basicTroop, eliteBasicTroop, canHaveSettlement, boardGameType,
        maleNameCount, femaleNameCount, defaultPolicyIdsJson, defaultPolicyCount
      ) VALUES (
        $cultureId, $filePath, $name, $descriptionText, $isMainCulture, $color, $color2,
        $basicTroop, $eliteBasicTroop, $canHaveSettlement, $boardGameType,
        $maleNameCount, $femaleNameCount, $defaultPolicyIdsJson, $defaultPolicyCount
      )
    `),
    insertSkillProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_skills (
        skillId, filePath, name, documentation, modifierCount, modifiersJson
      ) VALUES (
        $skillId, $filePath, $name, $documentation, $modifierCount, $modifiersJson
      )
    `),
    insertClanProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_clans (
        clanId, filePath, name, shortName, descriptionText, culture, owner, initialHomeSettlement,
        superFaction, tier, isNoble, isMinorFaction, isBandit, isOutlaw, isMafia, isMercenary, color, color2, templateCount
      ) VALUES (
        $clanId, $filePath, $name, $shortName, $descriptionText, $culture, $owner, $initialHomeSettlement,
        $superFaction, $tier, $isNoble, $isMinorFaction, $isBandit, $isOutlaw, $isMafia, $isMercenary, $color, $color2, $templateCount
      )
    `),
    insertKingdomProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_kingdoms (
        kingdomId, filePath, name, shortName, title, rulerTitle, descriptionText, culture, owner, initialHomeSettlement,
        color, color2, primaryBannerColor, secondaryBannerColor, relationshipCount, policyCount, policyIdsJson
      ) VALUES (
        $kingdomId, $filePath, $name, $shortName, $title, $rulerTitle, $descriptionText, $culture, $owner, $initialHomeSettlement,
        $color, $color2, $primaryBannerColor, $secondaryBannerColor, $relationshipCount, $policyCount, $policyIdsJson
      )
    `),
    insertSettlementProjection: db.prepare(`
      INSERT OR REPLACE INTO bannerlord_settlements (
        settlementId, filePath, name, descriptionText, owner, culture, settlementType, componentId, boundSettlement, villageType,
        prosperityOrHearth, positionX, positionY, sceneName, locationCount, buildingCount
      ) VALUES (
        $settlementId, $filePath, $name, $descriptionText, $owner, $culture, $settlementType, $componentId, $boundSettlement, $villageType,
        $prosperityOrHearth, $positionX, $positionY, $sceneName, $locationCount, $buildingCount
      )
    `),
    insertParseFailure: db.prepare(`
      INSERT OR REPLACE INTO xml_parse_failures (filePath, moduleName, category, errorName, message)
      VALUES ($filePath, $moduleName, $category, $errorName, $message)
    `),
  }
}

/** Writes one parsed document into every table, deduping rows first. */
function applyXmlRow(row: XmlDocumentRow, statements: ReturnType<typeof prepareXmlInsertStatements>): void {
  statements.insertFts.run({
    $filePath: row.filePath,
    $moduleName: row.moduleName,
    $content: row.content,
  })

  for (const entity of dedupeXmlEntities(row.entities)) {
    statements.insertEntity.run({
      $entityType: entity.entityType,
      $entityId: entity.entityId,
      $name: entity.name,
      $filePath: entity.filePath,
    })
  }

  for (const localization of dedupeLocalizations(row.localizations)) {
    statements.insertLocalization.run({
      $language: localization.language,
      $stringId: localization.stringId,
      $text: localization.text,
      $filePath: localization.filePath,
    })
  }

  for (const item of dedupeItemProjections(row.itemProjections)) {
    statements.insertItemProjection.run({
      $entityId: item.entityId,
      $entityKind: item.entityKind,
      $filePath: item.filePath,
      $name: item.name,
      $itemType: item.itemType,
      $weight: item.weight,
      $value: item.value,
      $weaponLength: item.weaponLength,
      $swingDamage: item.swingDamage,
      $swingDamageType: item.swingDamageType,
      $thrustDamage: item.thrustDamage,
      $thrustDamageType: item.thrustDamageType,
      $speedRating: item.speedRating,
      $balanceOrHitPoints: item.balanceOrHitPoints,
      $headArmor: item.headArmor,
      $bodyArmor: item.bodyArmor,
      $legArmor: item.legArmor,
      $armArmor: item.armArmor,
      $horseChargeDamage: item.horseChargeDamage,
      $horseSpeed: item.horseSpeed,
      $horseManeuver: item.horseManeuver,
      $tier: item.tier,
      $pieceType: item.pieceType,
      $length: item.length,
      $materialCount: item.materialCount,
    })
  }

  for (const troop of dedupeTroopProjections(row.troopProjections)) {
    statements.insertTroopProjection.run({
      $characterId: troop.characterId,
      $filePath: troop.filePath,
      $name: troop.name,
      $level: troop.level,
      $culture: troop.culture,
      $occupation: troop.occupation,
      $skillTemplate: troop.skillTemplate,
      $isHero: troop.isHero,
      $isFemale: troop.isFemale,
      $upgradeTargetsJson: troop.upgradeTargetsJson,
    })
  }

  for (const hero of dedupeHeroProjections(row.heroProjections)) {
    statements.insertHeroProjection.run({
      $heroId: hero.heroId,
      $filePath: hero.filePath,
      $faction: hero.faction,
      $clan: hero.clan,
      $spouse: hero.spouse,
      $father: hero.father,
      $mother: hero.mother,
      $alive: hero.alive,
      $isTemplate: hero.isTemplate,
      $text: hero.text,
    })
  }

  for (const culture of dedupeCultureProjections(row.cultureProjections)) {
    statements.insertCultureProjection.run({
      $cultureId: culture.cultureId,
      $filePath: culture.filePath,
      $name: culture.name,
      $descriptionText: culture.descriptionText,
      $isMainCulture: culture.isMainCulture,
      $color: culture.color,
      $color2: culture.color2,
      $basicTroop: culture.basicTroop,
      $eliteBasicTroop: culture.eliteBasicTroop,
      $canHaveSettlement: culture.canHaveSettlement,
      $boardGameType: culture.boardGameType,
      $maleNameCount: culture.maleNameCount,
      $femaleNameCount: culture.femaleNameCount,
      $defaultPolicyIdsJson: culture.defaultPolicyIdsJson,
      $defaultPolicyCount: culture.defaultPolicyCount,
    })
  }

  for (const skill of dedupeSkillProjections(row.skillProjections)) {
    statements.insertSkillProjection.run({
      $skillId: skill.skillId,
      $filePath: skill.filePath,
      $name: skill.name,
      $documentation: skill.documentation,
      $modifierCount: skill.modifierCount,
      $modifiersJson: skill.modifiersJson,
    })
  }

  for (const clan of dedupeClanProjections(row.clanProjections)) {
    statements.insertClanProjection.run({
      $clanId: clan.clanId,
      $filePath: clan.filePath,
      $name: clan.name,
      $shortName: clan.shortName,
      $descriptionText: clan.descriptionText,
      $culture: clan.culture,
      $owner: clan.owner,
      $initialHomeSettlement: clan.initialHomeSettlement,
      $superFaction: clan.superFaction,
      $tier: clan.tier,
      $isNoble: clan.isNoble,
      $isMinorFaction: clan.isMinorFaction,
      $isBandit: clan.isBandit,
      $isOutlaw: clan.isOutlaw,
      $isMafia: clan.isMafia,
      $isMercenary: clan.isMercenary,
      $color: clan.color,
      $color2: clan.color2,
      $templateCount: clan.templateCount,
    })
  }

  for (const kingdom of dedupeKingdomProjections(row.kingdomProjections)) {
    statements.insertKingdomProjection.run({
      $kingdomId: kingdom.kingdomId,
      $filePath: kingdom.filePath,
      $name: kingdom.name,
      $shortName: kingdom.shortName,
      $title: kingdom.title,
      $rulerTitle: kingdom.rulerTitle,
      $descriptionText: kingdom.descriptionText,
      $culture: kingdom.culture,
      $owner: kingdom.owner,
      $initialHomeSettlement: kingdom.initialHomeSettlement,
      $color: kingdom.color,
      $color2: kingdom.color2,
      $primaryBannerColor: kingdom.primaryBannerColor,
      $secondaryBannerColor: kingdom.secondaryBannerColor,
      $relationshipCount: kingdom.relationshipCount,
      $policyCount: kingdom.policyCount,
      $policyIdsJson: kingdom.policyIdsJson,
    })
  }

  for (const settlement of dedupeSettlementProjections(row.settlementProjections)) {
    statements.insertSettlementProjection.run({
      $settlementId: settlement.settlementId,
      $filePath: settlement.filePath,
      $name: settlement.name,
      $descriptionText: settlement.descriptionText,
      $owner: settlement.owner,
      $culture: settlement.culture,
      $settlementType: settlement.settlementType,
      $componentId: settlement.componentId,
      $boundSettlement: settlement.boundSettlement,
      $villageType: settlement.villageType,
      $prosperityOrHearth: settlement.prosperityOrHearth,
      $positionX: settlement.positionX,
      $positionY: settlement.positionY,
      $sceneName: settlement.sceneName,
      $locationCount: settlement.locationCount,
      $buildingCount: settlement.buildingCount,
    })
  }

  if (row.parseFailure) {
    statements.insertParseFailure.run({
      $filePath: row.parseFailure.filePath,
      $moduleName: row.parseFailure.moduleName,
      $category: row.parseFailure.category,
      $errorName: row.parseFailure.errorName,
      $message: row.parseFailure.message,
    })
  }
}

if (import.meta.main) {
  buildXmlIndex().catch(error => {
    console.error(formatXmlIndexError(error))
    process.exit(1)
  })
}

function formatXmlIndexError(error: unknown): string {
  if (isSqliteBusyError(error)) {
    return 'Fatal error while building the XML index: SQLite database is locked. Stop any running BannerlordSage MCP server or other processes using the local database, then try again.'
  }

  return `Fatal error while building the XML index: ${error instanceof Error ? error.stack || error.message : String(error)}`
}

function isSqliteBusyError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name} ${error.message}` : String(error)
  return /SQLITE_BUSY|database is locked/i.test(text)
}
