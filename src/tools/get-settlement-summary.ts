// Settlement lookup (towns, castles, villages). Ownership is derived: the
// bound village inherits its parent settlement's owner when it has none of
// its own, and clan owners are walked up to their kingdom.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import {
  formatReferenceLabel,
  lookupClanInfo,
  lookupCultureName,
  lookupKingdomInfo,
  lookupSettlementInfo,
} from '../utils/bannerlord-entity-resolver'
import { resolveMaybeLocalizedText } from '../utils/localization'

/** The owner label pair a settlement renders: who holds it, and its kingdom. */
type OwnerLabels = { ownerLabel: string; kingdomLabel: string | null }

export async function getSettlementSummary(settlementId: string) {
  const db = getDb()
  const settlementRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_settlements
      WHERE settlementId = $id
      ORDER BY
        CASE settlementType
          WHEN 'town' THEN 0
          WHEN 'castle' THEN 1
          WHEN 'village' THEN 2
          ELSE 3
        END,
        filePath
    `
    )
    .all({ $id: settlementId })

  if (settlementRecords.length === 0) {
    return textReply(`Settlement not found: ${settlementId}`)
  }

  const blocks: AiTextBlock[] = settlementRecords.map((settlement, position) => {
    const cultureLabel = lookupCultureName(db, settlement.culture)
    const ownership = resolveSettlementOwner(db, settlement.owner, settlement.boundSettlement)
    const boundSettlement = lookupSettlementInfo(db, settlement.boundSettlement)
    // The bound-settlement line is present when the raw reference or a resolved
    // name exists.
    const hasBoundSettlement = Boolean(settlement.boundSettlement || boundSettlement?.name)

    return {
      header: `settlement_${position + 1}`,
      fields: [
        { key: 'source_path', value: settlement.filePath },
        { key: 'settlement_id', value: settlement.settlementId },
        { key: 'display_name', value: resolveMaybeLocalizedText(settlement.name) },
        { key: 'settlement_type', value: settlement.settlementType },
        { key: 'culture_ref', value: formatReferenceLabel(settlement.culture, cultureLabel) },
        { key: 'owner_faction_ref', value: ownership.ownerLabel },
        { key: 'derived_kingdom_ref', value: ownership.kingdomLabel },
        {
          key: 'bound_settlement_ref',
          value: hasBoundSettlement
            ? formatReferenceLabel(settlement.boundSettlement, boundSettlement?.name)
            : null,
        },
        { key: 'component_id', value: settlement.componentId },
        { key: 'village_type', value: settlement.villageType },
        { key: 'prosperity_or_hearth', value: settlement.prosperityOrHearth },
        { key: 'map_pos_x', value: settlement.positionX },
        { key: 'map_pos_y', value: settlement.positionY },
        { key: 'primary_scene', value: settlement.sceneName },
        { key: 'location_node_count', value: settlement.locationCount },
        { key: 'building_node_count', value: settlement.buildingCount },
      ],
      multilineFields: [
        {
          key: 'description',
          value: settlement.descriptionText ? resolveMaybeLocalizedText(settlement.descriptionText) : null,
        },
      ],
    }
  })

  return textReply(renderAiTextReport('settlement_summary', 'query_settlement_id', settlementId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function textReply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * Two-step ownership resolution. A directly-named holder wins. Otherwise a
 * village with no owner of its own inherits the owner of the settlement it is
 * bound to. When neither step names anyone the pair degrades to "unknown".
 */
function resolveSettlementOwner(
  db: ReturnType<typeof getDb>,
  ownerReference: string | null,
  boundSettlementReference: string | null
): OwnerLabels {
  const directHolder = describeFactionReference(db, ownerReference)
  if (directHolder.ownerLabel !== 'unknown') {
    return directHolder
  }

  const boundSettlement = lookupSettlementInfo(db, boundSettlementReference)
  if (boundSettlement?.owner) {
    return describeFactionReference(db, boundSettlement.owner)
  }

  return { ownerLabel: 'unknown', kingdomLabel: null }
}

/**
 * Resolves one faction reference. A clan resolves to its own name plus the
 * name of the kingdom it belongs to; a kingdom resolves to itself in both
 * slots. Anything else keeps the raw reference as the owner label.
 */
function describeFactionReference(
  db: ReturnType<typeof getDb>,
  reference: string | null
): OwnerLabels {
  const clan = lookupClanInfo(db, reference)
  if (clan) {
    const kingdom = lookupKingdomInfo(db, clan.superFaction)
    return {
      ownerLabel: formatReferenceLabel(reference, clan.name),
      kingdomLabel: kingdom ? formatReferenceLabel(clan.superFaction, kingdom.name) : null,
    }
  }

  const kingdom = lookupKingdomInfo(db, reference)
  if (kingdom) {
    return {
      ownerLabel: formatReferenceLabel(reference, kingdom.name),
      kingdomLabel: formatReferenceLabel(reference, kingdom.name),
    }
  }

  return {
    ownerLabel: reference || 'unknown',
    kingdomLabel: null,
  }
}
