// Perk lookup. Perk ids are case-sensitive in game data, so the query
// matches exactly or case-insensitively in one pass. The alternative-perk
// reference resolves to a display name where one exists.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getPerkData(perkId: string) {
  const db = getDb()
  const perkRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_perks
      WHERE perkId = $perkId OR lower(perkId) = lower($perkId)
      ORDER BY sourceOrder
    `
    )
    .all({ $perkId: perkId })

  if (perkRecords.length === 0) {
    return contentWithText(`Perk not found: ${perkId}`)
  }

  const blocks: AiTextBlock[] = perkRecords.map((perk, position) => ({
    header: `perk_${position + 1}`,
    fields: [
      { key: 'source_path', value: perk.filePath },
      { key: 'perk_id', value: perk.perkId },
      { key: 'source_module', value: perk.sourceModule },
      { key: 'skill_id', value: perk.skillId },
      { key: 'tier_index', value: perk.tierIndex },
      { key: 'required_skill_value', value: perk.requiredSkillValue },
      { key: 'display_name', value: perk.displayName ? resolveMaybeLocalizedText(perk.displayName) : null },
      { key: 'alternative_perk_ref', value: describeAlternativePerk(db, perk.alternativePerkId) },
      { key: 'primary_role', value: perk.primaryRole },
      { key: 'primary_bonus', value: perk.primaryBonus },
      { key: 'primary_increment_type', value: perk.primaryIncrementType },
      { key: 'primary_troop_usage_mask', value: perk.primaryTroopUsageMask },
      { key: 'secondary_role', value: perk.secondaryRole },
      { key: 'secondary_bonus', value: perk.secondaryBonus },
      { key: 'secondary_increment_type', value: perk.secondaryIncrementType },
      { key: 'secondary_troop_usage_mask', value: perk.secondaryTroopUsageMask },
      { key: 'source_order', value: perk.sourceOrder },
    ],
    multilineFields: [
      { key: 'primary_description', value: perk.primaryDescription ? resolveMaybeLocalizedText(perk.primaryDescription) : null },
      {
        key: 'secondary_description',
        value: perk.secondaryDescription ? resolveMaybeLocalizedText(perk.secondaryDescription) : null,
      },
    ],
  }))

  return contentWithText(renderAiTextReport('perk_data', 'query_perk_id', perkId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function contentWithText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * The alternative perk renders as "Display Name [raw_id]" when the partner
 * perk has a display name, as the bare raw id when it does not, and as null
 * when this perk declares no alternative at all.
 */
function describeAlternativePerk(db: ReturnType<typeof getDb>, alternativePerkId: string | null): string | null {
  if (!alternativePerkId) {
    return null
  }

  const partnerName = lookupPerkName(db, alternativePerkId)
  if (partnerName) {
    return `${resolveMaybeLocalizedText(partnerName)} [${alternativePerkId}]`
  }

  return alternativePerkId
}

function lookupPerkName(db: ReturnType<typeof getDb>, perkId: string | null): string | null {
  if (!perkId) {
    return null
  }

  const match = db
    .query<{ displayName: string | null } | null, { $perkId: string }>(
      `
      SELECT displayName
      FROM bannerlord_perks
      WHERE perkId = $perkId
      LIMIT 1
    `
    )
    .get({ $perkId: perkId })

  return match?.displayName ?? null
}
