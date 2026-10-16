/**
 * Reference resolution against the game index: strip a reference prefix
 * (`Culture.`, `Faction.`, …), look the id up in its table, and format a
 * "DisplayName [reference]" label for tool output. Each lookup orders its
 * candidate rows deterministically (file path as final tiebreaker).
 */
import type { Database } from 'bun:sqlite'
import { normalizeBannerlordPolicyId } from './bannerlord-policy-id'
import { resolveMaybeLocalizedText } from './localization'

export type BannerlordClanInfo = {
  clanId: string
  name: string | null
  superFaction: string | null
  isNoble: number
  isMinorFaction: number
  isBandit: number
  isMercenary: number
}

export type BannerlordKingdomInfo = {
  kingdomId: string
  name: string | null
}

export type BannerlordSettlementInfo = {
  settlementId: string
  name: string | null
  owner: string | null
  boundSettlement: string | null
  settlementType: string | null
}

/** Removes the first matching reference prefix; blank input yields null. */
export function normalizeReference(value: string | null | undefined, prefixes: string[]): string | null {
  if (!value) return null

  const matchingPrefix = prefixes.find(prefix => value.startsWith(prefix))
  if (matchingPrefix) {
    return value.slice(matchingPrefix.length)
  }

  return value
}

/**
 * Runs a single-row lookup and returns null for "no row". Every query below
 * ends in `LIMIT 1` and is allowed to return nothing, so the `?? null`
 * decision lives here instead of at seven call sites.
 */
function firstRowOrNull<TRow>(db: Database, sql: string, $id: string): TRow | null {
  const row = db.query<TRow | null, { $id: string }>(sql).get({ $id })
  return row ?? null
}

/** Culture display name; prefers cultures with more name data available. */
export function lookupCultureName(db: Database, reference: string | null | undefined): string | null {
  const cultureId = normalizeReference(reference, ['Culture.'])
  if (!cultureId) return null

  const row = firstRowOrNull<{ name: string | null }>(
    db,
    `
      SELECT name
      FROM bannerlord_cultures
      WHERE cultureId = $id
      ORDER BY
        (maleNameCount + femaleNameCount) DESC,
        CASE WHEN descriptionText IS NOT NULL AND descriptionText <> '' THEN 0 ELSE 1 END,
        filePath
      LIMIT 1
    `,
    cultureId
  )

  return row?.name ?? null
}

/** Hero display name; hero and NPCCharacter references share the troops
 * table, so both prefixes are accepted. */
export function lookupHeroName(db: Database, reference: string | null | undefined): string | null {
  const heroId = normalizeReference(reference, ['Hero.', 'NPCCharacter.'])
  if (!heroId) return null

  const row = firstRowOrNull<{ name: string | null }>(
    db,
    `
      SELECT name
      FROM bannerlord_troops
      WHERE characterId = $id
      ORDER BY filePath
      LIMIT 1
    `,
    heroId
  )

  return row?.name ?? null
}

/** Clan record; noble clans sort ahead of minor factions, then everyone else. */
export function lookupClanInfo(db: Database, reference: string | null | undefined): BannerlordClanInfo | null {
  const clanId = normalizeReference(reference, ['Faction.', 'Clan.'])
  if (!clanId) return null

  return firstRowOrNull<BannerlordClanInfo>(
    db,
    `
        SELECT clanId, name, superFaction, isNoble, isMinorFaction, isBandit, isMercenary
        FROM bannerlord_clans
        WHERE clanId = $id
        ORDER BY
          CASE WHEN isNoble = 1 THEN 0 WHEN isMinorFaction = 1 THEN 1 ELSE 2 END,
          filePath
        LIMIT 1
      `,
    clanId
  )
}

export function lookupKingdomInfo(db: Database, reference: string | null | undefined): BannerlordKingdomInfo | null {
  const kingdomId = normalizeReference(reference, ['Faction.', 'Kingdom.'])
  if (!kingdomId) return null

  return firstRowOrNull<BannerlordKingdomInfo>(
    db,
    `
        SELECT kingdomId, name
        FROM bannerlord_kingdoms
        WHERE kingdomId = $id
        ORDER BY filePath
        LIMIT 1
      `,
    kingdomId
  )
}

export function lookupPolicyName(db: Database, reference: string | null | undefined): string | null {
  const policyId = normalizeBannerlordPolicyId(reference)
  if (!policyId) return null

  const row = firstRowOrNull<{ displayName: string | null }>(
    db,
    `
      SELECT displayName
      FROM bannerlord_policies
      WHERE policyId = $id
      LIMIT 1
    `,
    policyId
  )

  return row?.displayName ?? null
}

export function lookupSettlementInfo(db: Database, reference: string | null | undefined): BannerlordSettlementInfo | null {
  const settlementId = normalizeReference(reference, ['Settlement.'])
  if (!settlementId) return null

  return firstRowOrNull<BannerlordSettlementInfo>(
    db,
    `
        SELECT settlementId, name, owner, boundSettlement, settlementType
        FROM bannerlord_settlements
        WHERE settlementId = $id
        ORDER BY filePath
        LIMIT 1
      `,
    settlementId
  )
}

/** Human-readable label: localized display name plus the raw reference in
 * brackets; falls back to the bare reference, then 'unknown'. */
export function formatReferenceLabel(
  rawReference: string | null | undefined,
  displayName: string | null | undefined,
  preferredLanguages?: string[]
): string {
  if (!displayName) {
    return rawReference || 'unknown'
  }

  const localized = resolveMaybeLocalizedText(displayName, preferredLanguages)
  if (!rawReference) {
    return localized
  }

  return `${localized} [${rawReference}]`
}
