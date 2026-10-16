// Kingdom lookup with resolved framework references: culture, ruler, home
// settlement, and the kingdom's active policies as display labels.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import {
  formatReferenceLabel,
  lookupCultureName,
  lookupHeroName,
  lookupPolicyName,
  lookupSettlementInfo,
} from '../utils/bannerlord-entity-resolver'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getKingdomSummary(kingdomId: string) {
  const db = getDb()
  const kingdomRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_kingdoms
      WHERE kingdomId = $id
      ORDER BY filePath
    `
    )
    .all({ $id: kingdomId })

  if (kingdomRecords.length === 0) {
    return onlyText(`Kingdom not found: ${kingdomId}`)
  }

  const blocks: AiTextBlock[] = kingdomRecords.map((kingdom, position) => {
    const cultureLabel = lookupCultureName(db, kingdom.culture)
    const rulerLabel = lookupHeroName(db, kingdom.owner)
    const homeSettlement = lookupSettlementInfo(db, kingdom.initialHomeSettlement)
    const policyRefs = parseIdList(kingdom.policyIdsJson).map(policyId =>
      formatReferenceLabel(policyId, lookupPolicyName(db, policyId))
    )

    return {
      header: `kingdom_${position + 1}`,
      fields: [
        { key: 'source_path', value: kingdom.filePath },
        { key: 'kingdom_id', value: kingdom.kingdomId },
        { key: 'display_name', value: resolveMaybeLocalizedText(kingdom.name) },
        { key: 'short_name', value: optionalLocalized(kingdom.shortName) },
        { key: 'title', value: optionalLocalized(kingdom.title) },
        { key: 'ruler_title', value: optionalLocalized(kingdom.rulerTitle) },
        { key: 'culture_ref', value: formatReferenceLabel(kingdom.culture, cultureLabel) },
        { key: 'owner_hero_ref', value: formatReferenceLabel(kingdom.owner, rulerLabel) },
        {
          key: 'home_settlement_ref',
          value: formatReferenceLabel(kingdom.initialHomeSettlement, homeSettlement?.name),
        },
        { key: 'color_primary', value: kingdom.color },
        { key: 'color_secondary', value: kingdom.color2 },
        { key: 'banner_color_primary', value: kingdom.primaryBannerColor },
        { key: 'banner_color_secondary', value: kingdom.secondaryBannerColor },
        { key: 'relationship_count', value: kingdom.relationshipCount },
        { key: 'policy_count', value: kingdom.policyCount },
      ],
      listFields: [{ key: 'active_policy_refs', values: policyRefs }],
      multilineFields: [
        { key: 'description', value: optionalLocalized(kingdom.descriptionText) },
      ],
    }
  })

  return onlyText(renderAiTextReport('kingdom_summary', 'query_kingdom_id', kingdomId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function onlyText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** A stored, possibly-empty text renders only when the column has a value. */
function optionalLocalized(stored: string | null): string | null {
  return stored ? resolveMaybeLocalizedText(stored) : null
}

/** Stored id lists are JSON arrays of strings; anything else yields no ids. */
function parseIdList(raw: string): string[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(decoded)) {
    return []
  }
  return decoded.filter((entry): entry is string => typeof entry === 'string')
}
