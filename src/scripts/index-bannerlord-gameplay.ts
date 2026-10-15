import { Database } from 'bun:sqlite'
import { readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { getGamePaths } from '../utils/env'
import { normalizeBannerlordPolicyId } from '../utils/bannerlord-policy-id'

/**
 * Gameplay index: parses the decompiled CampaignSystem sources for policy
 * and perk definitions and projects them into dedicated SQLite tables that
 * downstream tools join against.
 *
 * The decompiled C# is parsed with structure-aware regexes (Create-map +
 * Initialize-call extraction); that is deliberate — a real Roslyn pass is
 * overkill for these two source files' highly regular shape.
 */

type BannerlordPolicyProjectionRow = {
  policyId: string
  rawPolicyId: string
  filePath: string
  sourceModule: string
  displayName: string | null
  descriptionText: string | null
  proposalText: string | null
  effectsText: string | null
  rulerSupport: number | null
  lordsSupport: number | null
  commonsSupport: number | null
  activeKingdomIdsJson: string
  defaultCultureIdsJson: string
  activeKingdomCount: number
  defaultCultureCount: number
}

type BannerlordPerkProjectionRow = {
  perkId: string
  filePath: string
  sourceModule: string
  skillId: string | null
  tierIndex: number | null
  requiredSkillValue: number | null
  alternativePerkId: string | null
  displayName: string | null
  primaryDescription: string | null
  primaryRole: string | null
  primaryBonus: number | null
  primaryIncrementType: string | null
  primaryTroopUsageMask: string | null
  secondaryDescription: string | null
  secondaryRole: string | null
  secondaryBonus: number | null
  secondaryIncrementType: string | null
  secondaryTroopUsageMask: string | null
  sourceOrder: number
}

/** Positional argument layout of `DefaultPerk.Initialize(...)` calls. */
const PERK_ARGUMENT_INDEX = {
  displayName: 0,
  skillId: 1,
  tier: 2,
  alternative: 3,
  primaryDescription: 4,
  primaryRole: 5,
  primaryBonus: 6,
  primaryIncrementType: 7,
  secondaryDescription: 8,
  secondaryRole: 9,
  secondaryBonus: 10,
  secondaryIncrementType: 11,
  primaryTroopUsageMask: 12,
  secondaryTroopUsageMask: 13,
} as const

/** A valid policy/perk Initialize call must supply at least this many args. */
const POLICY_MIN_ARGUMENTS = 7
const PERK_MIN_ARGUMENTS = 8

const DEFAULT_PERKS_RELATIVE_PATH = join(
  'bin',
  'Win64_Shipping_Client',
  'TaleWorlds.CampaignSystem',
  'TaleWorlds.CampaignSystem.CharacterDevelopment',
  'DefaultPerks.cs'
)

const POLICY_SOURCE_RELATIVE_PATHS = [
  join(
    'bin',
    'Win64_Shipping_Client',
    'TaleWorlds.CampaignSystem',
    'TaleWorlds.CampaignSystem',
    'DefaultPolicies.cs'
  ),
  join('Modules', 'NavalDLC', 'bin', 'Win64_Shipping_Client', 'NavalDLC', 'NavalDLC', 'NavalPolicies.cs'),
]

/** Used when the source's own TierSkillRequirements table cannot be found. */
const DEFAULT_TIER_SKILL_REQUIREMENTS = [25, 50, 75, 100, 125, 150, 175, 200, 225, 250, 275, 300]

export async function buildBannerlordGameplayIndex(gameId?: string): Promise<{
  policiesIndexed: number
  perksIndexed: number
}> {
  const { gameId: resolvedGameId, sourcePath, dbPath } = getGamePaths(gameId)
  if (resolvedGameId !== 'bannerlord') {
    return {
      policiesIndexed: 0,
      perksIndexed: 0,
    }
  }

  const db = new Database(dbPath)

  try {
    applySqlitePragmas(db)

    const activeKingdomIdsByPolicy = loadPolicyRefsByEntity(db, 'bannerlord_kingdoms', 'kingdomId', 'policyIdsJson')
    const defaultCultureIdsByPolicy = loadPolicyRefsByEntity(
      db,
      'bannerlord_cultures',
      'cultureId',
      'defaultPolicyIdsJson'
    )

    const [policies, perks] = await Promise.all([
      extractPolicyProjections(sourcePath, activeKingdomIdsByPolicy, defaultCultureIdsByPolicy),
      extractPerkProjections(sourcePath),
    ])

    createGameplayTables(db)

    insertGameplayRows(db, policies, perks)

    console.log(`Indexed ${policies.length} Bannerlord policies and ${perks.length} Bannerlord perks.`)

    return {
      policiesIndexed: policies.length,
      perksIndexed: perks.length,
    }
  } finally {
    db.close()
  }
}

function applySqlitePragmas(db: Database): void {
  db.run('PRAGMA busy_timeout = 5000;')
  db.run('PRAGMA journal_mode = WAL;')
}

function createGameplayTables(db: Database): void {
  db.run('DROP TABLE IF EXISTS bannerlord_policies;')
  db.run('DROP TABLE IF EXISTS bannerlord_perks;')

  db.run(`
    CREATE TABLE bannerlord_policies (
      policyId TEXT PRIMARY KEY,
      rawPolicyId TEXT NOT NULL,
      filePath TEXT NOT NULL,
      sourceModule TEXT NOT NULL,
      displayName TEXT,
      descriptionText TEXT,
      proposalText TEXT,
      effectsText TEXT,
      rulerSupport REAL,
      lordsSupport REAL,
      commonsSupport REAL,
      activeKingdomIdsJson TEXT NOT NULL,
      defaultCultureIdsJson TEXT NOT NULL,
      activeKingdomCount INTEGER NOT NULL,
      defaultCultureCount INTEGER NOT NULL
    );
  `)

  db.run(`
    CREATE TABLE bannerlord_perks (
      perkId TEXT PRIMARY KEY,
      filePath TEXT NOT NULL,
      sourceModule TEXT NOT NULL,
      skillId TEXT,
      tierIndex INTEGER,
      requiredSkillValue INTEGER,
      alternativePerkId TEXT,
      displayName TEXT,
      primaryDescription TEXT,
      primaryRole TEXT,
      primaryBonus REAL,
      primaryIncrementType TEXT,
      primaryTroopUsageMask TEXT,
      secondaryDescription TEXT,
      secondaryRole TEXT,
      secondaryBonus REAL,
      secondaryIncrementType TEXT,
      secondaryTroopUsageMask TEXT,
      sourceOrder INTEGER NOT NULL
    );
  `)

  db.run('CREATE INDEX bannerlord_policies_source_module_idx ON bannerlord_policies(sourceModule);')
  db.run('CREATE INDEX bannerlord_perks_skill_id_idx ON bannerlord_perks(skillId);')
  db.run('CREATE INDEX bannerlord_perks_source_order_idx ON bannerlord_perks(sourceOrder);')
}

function insertGameplayRows(
  db: Database,
  policies: BannerlordPolicyProjectionRow[],
  perks: BannerlordPerkProjectionRow[]
): void {
  const insertPolicy = db.prepare(`
    INSERT OR REPLACE INTO bannerlord_policies (
      policyId, rawPolicyId, filePath, sourceModule, displayName, descriptionText, proposalText, effectsText,
      rulerSupport, lordsSupport, commonsSupport, activeKingdomIdsJson, defaultCultureIdsJson,
      activeKingdomCount, defaultCultureCount
    ) VALUES (
      $policyId, $rawPolicyId, $filePath, $sourceModule, $displayName, $descriptionText, $proposalText, $effectsText,
      $rulerSupport, $lordsSupport, $commonsSupport, $activeKingdomIdsJson, $defaultCultureIdsJson,
      $activeKingdomCount, $defaultCultureCount
    )
  `)

  const insertPerk = db.prepare(`
    INSERT OR REPLACE INTO bannerlord_perks (
      perkId, filePath, sourceModule, skillId, tierIndex, requiredSkillValue, alternativePerkId,
      displayName, primaryDescription, primaryRole, primaryBonus, primaryIncrementType, primaryTroopUsageMask,
      secondaryDescription, secondaryRole, secondaryBonus, secondaryIncrementType, secondaryTroopUsageMask, sourceOrder
    ) VALUES (
      $perkId, $filePath, $sourceModule, $skillId, $tierIndex, $requiredSkillValue, $alternativePerkId,
      $displayName, $primaryDescription, $primaryRole, $primaryBonus, $primaryIncrementType, $primaryTroopUsageMask,
      $secondaryDescription, $secondaryRole, $secondaryBonus, $secondaryIncrementType, $secondaryTroopUsageMask, $sourceOrder
    )
  `)

  const insertAll = db.transaction(() => {
    for (const row of policies) {
      insertPolicy.run({
        $policyId: row.policyId,
        $rawPolicyId: row.rawPolicyId,
        $filePath: row.filePath,
        $sourceModule: row.sourceModule,
        $displayName: row.displayName,
        $descriptionText: row.descriptionText,
        $proposalText: row.proposalText,
        $effectsText: row.effectsText,
        $rulerSupport: row.rulerSupport,
        $lordsSupport: row.lordsSupport,
        $commonsSupport: row.commonsSupport,
        $activeKingdomIdsJson: row.activeKingdomIdsJson,
        $defaultCultureIdsJson: row.defaultCultureIdsJson,
        $activeKingdomCount: row.activeKingdomCount,
        $defaultCultureCount: row.defaultCultureCount,
      })
    }

    for (const row of perks) {
      insertPerk.run({
        $perkId: row.perkId,
        $filePath: row.filePath,
        $sourceModule: row.sourceModule,
        $skillId: row.skillId,
        $tierIndex: row.tierIndex,
        $requiredSkillValue: row.requiredSkillValue,
        $alternativePerkId: row.alternativePerkId,
        $displayName: row.displayName,
        $primaryDescription: row.primaryDescription,
        $primaryRole: row.primaryRole,
        $primaryBonus: row.primaryBonus,
        $primaryIncrementType: row.primaryIncrementType,
        $primaryTroopUsageMask: row.primaryTroopUsageMask,
        $secondaryDescription: row.secondaryDescription,
        $secondaryRole: row.secondaryRole,
        $secondaryBonus: row.secondaryBonus,
        $secondaryIncrementType: row.secondaryIncrementType,
        $secondaryTroopUsageMask: row.secondaryTroopUsageMask,
        $sourceOrder: row.sourceOrder,
      })
    }
  })

  insertAll()
}

async function extractPolicyProjections(
  sourcePath: string,
  activeKingdomIdsByPolicy: Map<string, string[]>,
  defaultCultureIdsByPolicy: Map<string, string[]>
): Promise<BannerlordPolicyProjectionRow[]> {
  const rows: BannerlordPolicyProjectionRow[] = []

  for (const relativePath of POLICY_SOURCE_RELATIVE_PATHS) {
    const absolutePath = join(sourcePath, relativePath)
    if (!(await pathExists(absolutePath))) {
      continue
    }

    const sourceText = await readFile(absolutePath, 'utf8')
    const createdIds = parseCreateMap(sourceText)
    const sourceModule = inferSourceModule(relativePath)

    for (const { fieldName, argumentsText } of extractInitializeCalls(sourceText)) {
      const rawPolicyId = createdIds.get(fieldName)
      if (!rawPolicyId) {
        continue
      }

      const policyId = normalizeBannerlordPolicyId(rawPolicyId)
      if (!policyId) {
        continue
      }

      const args = splitTopLevelArguments(argumentsText)
      if (args.length < POLICY_MIN_ARGUMENTS) {
        continue
      }

      const activeKingdomIds = activeKingdomIdsByPolicy.get(policyId) ?? []
      const defaultCultureIds = defaultCultureIdsByPolicy.get(policyId) ?? []

      rows.push({
        policyId,
        rawPolicyId,
        filePath: normalizeSourceFilePath(sourcePath, absolutePath),
        sourceModule,
        displayName: extractFirstStringLiteral(args[0]),
        descriptionText: extractFirstStringLiteral(args[1]),
        proposalText: extractFirstStringLiteral(args[2]),
        effectsText: extractFirstStringLiteral(args[3]),
        rulerSupport: parseNumericLiteral(args[4]),
        lordsSupport: parseNumericLiteral(args[5]),
        commonsSupport: parseNumericLiteral(args[6]),
        activeKingdomIdsJson: JSON.stringify(activeKingdomIds),
        defaultCultureIdsJson: JSON.stringify(defaultCultureIds),
        activeKingdomCount: activeKingdomIds.length,
        defaultCultureCount: defaultCultureIds.length,
      })
    }
  }

  return dedupePolicies(rows)
}

async function extractPerkProjections(sourcePath: string): Promise<BannerlordPerkProjectionRow[]> {
  const absolutePath = join(sourcePath, DEFAULT_PERKS_RELATIVE_PATH)
  if (!(await pathExists(absolutePath))) {
    return []
  }

  const sourceText = await readFile(absolutePath, 'utf8')
  const createdIds = parseCreateMap(sourceText)
  const tierSkillRequirements = parseTierSkillRequirements(sourceText)
  const rows: BannerlordPerkProjectionRow[] = []

  let sourceOrder = 0
  for (const { fieldName, argumentsText } of extractInitializeCalls(sourceText)) {
    const perkId = createdIds.get(fieldName)
    if (!perkId) {
      continue
    }

    const args = splitTopLevelArguments(argumentsText)
    if (args.length < PERK_MIN_ARGUMENTS) {
      continue
    }

    sourceOrder += 1
    const tier = resolveTierRequirement(args[PERK_ARGUMENT_INDEX.tier], tierSkillRequirements)
    const i = PERK_ARGUMENT_INDEX

    rows.push({
      perkId,
      filePath: normalizeSourceFilePath(sourcePath, absolutePath),
      sourceModule: 'CampaignSystem',
      skillId: normalizeMemberAccess(args[i.skillId], 'DefaultSkills.'),
      tierIndex: tier.tierIndex,
      requiredSkillValue: tier.requiredSkillValue,
      alternativePerkId: resolveCreatedReference(args[i.alternative], createdIds),
      displayName: extractFirstStringLiteral(args[i.displayName]),
      primaryDescription: extractFirstStringLiteral(args[i.primaryDescription]),
      primaryRole: normalizeMemberAccess(args[i.primaryRole], 'PartyRole.'),
      primaryBonus: parseNumericLiteral(args[i.primaryBonus]),
      primaryIncrementType: normalizeMemberAccess(args[i.primaryIncrementType], 'EffectIncrementType.'),
      primaryTroopUsageMask: normalizeFlagExpression(args[i.primaryTroopUsageMask], 'TroopUsageFlags.'),
      secondaryDescription: extractFirstStringLiteral(args[i.secondaryDescription]),
      secondaryRole: normalizeMemberAccess(args[i.secondaryRole], 'PartyRole.'),
      secondaryBonus: parseNumericLiteral(args[i.secondaryBonus]),
      secondaryIncrementType: normalizeMemberAccess(args[i.secondaryIncrementType], 'EffectIncrementType.'),
      secondaryTroopUsageMask: normalizeFlagExpression(args[i.secondaryTroopUsageMask], 'TroopUsageFlags.'),
      sourceOrder,
    })
  }

  return dedupePerks(rows)
}

/** Reads kingdom/culture → policy references from already-built XML tables. */
function loadPolicyRefsByEntity(
  db: Database,
  tableName: string,
  entityColumn: string,
  jsonColumn: string
): Map<string, string[]> {
  if (!tableExists(db, tableName) || !tableHasColumn(db, tableName, entityColumn) || !tableHasColumn(db, tableName, jsonColumn)) {
    return new Map()
  }

  const rows = db
    .query<Record<string, unknown>, never>(`SELECT ${entityColumn}, ${jsonColumn} FROM ${tableName}`)
    .all()

  const refsByPolicy = new Map<string, Set<string>>()
  for (const row of rows) {
    const entityId = typeof row[entityColumn] === 'string' ? row[entityColumn] : null
    if (!entityId) {
      continue
    }

    for (const policyId of parseIdList(row[jsonColumn])) {
      const bucket = refsByPolicy.get(policyId) ?? new Set<string>()
      bucket.add(entityId)
      refsByPolicy.set(policyId, bucket)
    }
  }

  return new Map(
    [...refsByPolicy.entries()].map(([policyId, values]) => [policyId, [...values].sort((left, right) => left.localeCompare(right))])
  )
}

/** Extracts `_<field> = Create("<id>");` pairs — the id registry of a source file. */
function parseCreateMap(sourceText: string): Map<string, string> {
  const idsByField = new Map<string, string>()
  const pattern = /^\s*(_[A-Za-z0-9]+)\s*=\s*Create\("([^"]+)"\);/gm

  let match: RegExpExecArray | null
  while ((match = pattern.exec(sourceText)) !== null) {
    idsByField.set(match[1], match[2])
  }

  return idsByField
}

/** Extracts every `_<field>.Initialize(...);` call with its raw argument list. */
function extractInitializeCalls(sourceText: string): Array<{ fieldName: string; argumentsText: string }> {
  const calls: Array<{ fieldName: string; argumentsText: string }> = []
  const pattern = /^\s*(_[A-Za-z0-9]+)\.Initialize\((.+)\);\s*$/gm

  let match: RegExpExecArray | null
  while ((match = pattern.exec(sourceText)) !== null) {
    calls.push({
      fieldName: match[1],
      argumentsText: match[2],
    })
  }

  return calls
}

/**
 * Splits a C# argument list on top-level commas only: strings, nested
 * parentheses, brackets, and braces are all respected.
 */
function splitTopLevelArguments(argumentsText: string): string[] {
  const parts: string[] = []
  let current = ''
  let parenDepth = 0
  let bracketDepth = 0
  let braceDepth = 0
  let inString = false
  let escaping = false

  for (const char of argumentsText) {
    current += char

    if (inString) {
      if (escaping) {
        escaping = false
        continue
      }

      if (char === '\\') {
        escaping = true
        continue
      }

      if (char === '"') {
        inString = false
      }

      continue
    }

    if (char === '"') {
      inString = true
      continue
    }

    if (char === '(') parenDepth += 1
    if (char === ')') parenDepth -= 1
    if (char === '[') bracketDepth += 1
    if (char === ']') bracketDepth -= 1
    if (char === '{') braceDepth += 1
    if (char === '}') braceDepth -= 1

    if (char === ',' && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
      parts.push(current.slice(0, -1).trim())
      current = ''
    }
  }

  if (current.trim().length > 0) {
    parts.push(current.trim())
  }

  return parts
}

/** First double-quoted literal in the expression, with C# escapes resolved. */
function extractFirstStringLiteral(expression: string | undefined): string | null {
  if (!expression) return null

  const match = expression.match(/"((?:\\.|[^"])*)"/)
  if (!match) return null

  return match[1]
    .replaceAll('\\"', '"')
    .replaceAll('\\n', '\n')
    .replaceAll('\\r', '\r')
    .replaceAll('\\\\', '\\')
}

/** C# numeric literal (optional trailing `f`); `null` yields null. */
function parseNumericLiteral(expression: string | undefined): number | null {
  if (!expression) return null

  const normalized = expression.trim().replace(/f$/i, '')
  if (!normalized || /^null$/i.test(normalized)) {
    return null
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Strips a qualification prefix (`DefaultSkills.` etc.) from a member
 * access expression; bare or `null` inputs pass through unchanged.
 */
function normalizeMemberAccess(expression: string | undefined, prefix: string): string | null {
  if (!expression) return null

  const trimmed = expression.trim()
  if (!trimmed || /^null$/i.test(trimmed)) {
    return null
  }

  if (trimmed.startsWith(prefix)) {
    return trimmed.slice(prefix.length)
  }

  return trimmed
}

/** Normalizes `Flag.A | Flag.B` expressions, dropping the shared prefix. */
function normalizeFlagExpression(expression: string | undefined, prefix: string): string | null {
  if (!expression) return null

  const trimmed = expression.trim()
  if (!trimmed || /^null$/i.test(trimmed)) {
    return null
  }

  return trimmed
    .split('|')
    .map(part => normalizeMemberAccess(part.trim(), prefix))
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' | ')
}

/** Resolves a field reference through the file's Create-map. */
function resolveCreatedReference(expression: string | undefined, createdIds: Map<string, string>): string | null {
  if (!expression) return null

  const trimmed = expression.trim()
  if (!trimmed || /^null$/i.test(trimmed)) {
    return null
  }

  return createdIds.get(trimmed) ?? null
}

/** Reads the source's tier→skill-value table, falling back to known defaults. */
function parseTierSkillRequirements(sourceText: string): number[] {
  const match = sourceText.match(/TierSkillRequirements\s*=\s*new int\[\d+\]\s*\{([\s\S]*?)\};/m)
  if (!match) {
    return DEFAULT_TIER_SKILL_REQUIREMENTS
  }

  const values = match[1]
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isFinite(value))

  return values.length > 0 ? values : DEFAULT_TIER_SKILL_REQUIREMENTS
}

/**
 * Tiers are expressed either as `GetTierCost(n)` (index into the table) or
 * as a direct skill-value literal (reverse lookup in the table).
 */
function resolveTierRequirement(
  expression: string | undefined,
  tierSkillRequirements: number[]
): { tierIndex: number | null; requiredSkillValue: number | null } {
  if (!expression) {
    return {
      tierIndex: null,
      requiredSkillValue: null,
    }
  }

  const tierCall = expression.match(/GetTierCost\((\d+)\)/)
  if (tierCall) {
    const tierIndex = Number(tierCall[1])
    const requiredSkillValue = tierSkillRequirements[tierIndex - 1] ?? null
    return { tierIndex, requiredSkillValue }
  }

  const directValue = parseNumericLiteral(expression)
  if (directValue === null) {
    return {
      tierIndex: null,
      requiredSkillValue: null,
    }
  }

  return {
    tierIndex: tierSkillRequirements.indexOf(directValue) + 1 || null,
    requiredSkillValue: directValue,
  }
}

/** Parses a JSON id array column, normalizing and sorting its members. */
function parseIdList(value: unknown): string[] {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return []
  }

  try {
    const parsed = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      return []
    }

    return [...new Set(parsed.map(item => normalizeBannerlordPolicyId(String(item))).filter(Boolean) as string[])].sort(
      (left, right) => left.localeCompare(right)
    )
  } catch {
    return []
  }
}

function dedupePolicies(rows: BannerlordPolicyProjectionRow[]): BannerlordPolicyProjectionRow[] {
  const seen = new Set<string>()
  const result: BannerlordPolicyProjectionRow[] = []

  for (const row of rows) {
    if (seen.has(row.policyId)) {
      continue
    }

    seen.add(row.policyId)
    result.push(row)
  }

  return result.sort((left, right) => left.policyId.localeCompare(right.policyId))
}

function dedupePerks(rows: BannerlordPerkProjectionRow[]): BannerlordPerkProjectionRow[] {
  const seen = new Set<string>()
  const result: BannerlordPerkProjectionRow[] = []

  for (const row of rows) {
    if (seen.has(row.perkId)) {
      continue
    }

    seen.add(row.perkId)
    result.push(row)
  }

  return result.sort((left, right) => left.sourceOrder - right.sourceOrder)
}

/** `Modules/<Name>/…` maps to the module name; core sources are CampaignSystem. */
function inferSourceModule(relativePath: string): string {
  const normalized = relativePath.replaceAll('\\', '/')
  if (normalized.startsWith('Modules/')) {
    return normalized.split('/')[1] || 'Modules'
  }

  return 'CampaignSystem'
}

function normalizeSourceFilePath(sourcePath: string, absolutePath: string): string {
  return relative(sourcePath, absolutePath).replaceAll('\\', '/')
}

function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .query<{ name: string } | null, { $tableName: string }>(
      `
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = $tableName
      LIMIT 1
    `
    )
    .get({ $tableName: tableName })

  return Boolean(row)
}

function tableHasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.query<{ name: string }, never>(`PRAGMA table_info("${tableName.replaceAll('"', '""')}")`).all()
  return rows.some(row => row.name === columnName)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

if (import.meta.main) {
  buildBannerlordGameplayIndex().catch(error => {
    console.error('Fatal error while building the Bannerlord gameplay index:', error)
    process.exit(1)
  })
}
