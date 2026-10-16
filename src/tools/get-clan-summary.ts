// Clan/faction lookup. Results order noble clans first, then minor
// factions, then the rest, with file path as the tiebreaker. Framework
// references (culture, owner, home settlement, super-faction) resolve to
// display labels inline.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import {
  formatReferenceLabel,
  lookupCultureName,
  lookupHeroName,
  lookupKingdomInfo,
  lookupSettlementInfo,
} from '../utils/bannerlord-entity-resolver'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getClanSummary(clanId: string) {
  const db = getDb()
  const clanRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_clans
      WHERE clanId = $id
      ORDER BY
        CASE WHEN isNoble = 1 THEN 0 WHEN isMinorFaction = 1 THEN 1 ELSE 2 END,
        filePath
    `
    )
    .all({ $id: clanId })

  if (clanRecords.length === 0) {
    return singleText(`Clan or faction not found: ${clanId}`)
  }

  const blocks: AiTextBlock[] = clanRecords.map((clan, position) => {
    const cultureLabel = lookupCultureName(db, clan.culture)
    const ownerLabel = lookupHeroName(db, clan.owner)
    const homeSettlement = lookupSettlementInfo(db, clan.initialHomeSettlement)
    const superFaction = lookupKingdomInfo(db, clan.superFaction)
    // The super-faction line is omitted when neither the raw reference nor a
    // resolved kingdom name is present.
    const hasSuperFaction = Boolean(clan.superFaction || superFaction?.name)

    return {
      header: `clan_${position + 1}`,
      fields: [
        { key: 'source_path', value: clan.filePath },
        { key: 'clan_id', value: clan.clanId },
        { key: 'display_name', value: resolveMaybeLocalizedText(clan.name) },
        { key: 'short_name', value: clan.shortName ? resolveMaybeLocalizedText(clan.shortName) : null },
        { key: 'kind', value: describeClanKind(clan) },
        { key: 'culture_ref', value: formatReferenceLabel(clan.culture, cultureLabel) },
        { key: 'owner_hero_ref', value: formatReferenceLabel(clan.owner, ownerLabel) },
        { key: 'home_settlement_ref', value: formatReferenceLabel(clan.initialHomeSettlement, homeSettlement?.name) },
        {
          key: 'super_faction_ref',
          value: hasSuperFaction ? formatReferenceLabel(clan.superFaction, superFaction?.name) : null,
        },
        { key: 'tier', value: clan.tier },
        { key: 'color_primary', value: clan.color },
        { key: 'color_secondary', value: clan.color2 },
        { key: 'template_count', value: clan.templateCount },
        { key: 'flag_is_noble', value: yesNo(clan.isNoble) },
        { key: 'flag_is_minor_faction', value: yesNo(clan.isMinorFaction) },
        { key: 'flag_is_bandit', value: yesNo(clan.isBandit) },
        { key: 'flag_is_outlaw', value: yesNo(clan.isOutlaw) },
        { key: 'flag_is_mafia', value: yesNo(clan.isMafia) },
        { key: 'flag_is_mercenary', value: yesNo(clan.isMercenary) },
      ],
      multilineFields: [
        { key: 'description', value: clan.descriptionText ? resolveMaybeLocalizedText(clan.descriptionText) : null },
      ],
    }
  })

  return singleText(renderAiTextReport('clan_summary', 'query_clan_id', clanId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function singleText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * The kind label is decided by the most specific flag that is set: a minor
 * mercenary faction is still a minor faction, so the mercenary flag only
 * splits the minor-faction branch.
 */
function describeClanKind(clan: any): string {
  if (clan.isNoble) {
    return 'noble clan'
  }
  if (clan.isMinorFaction) {
    return clan.isMercenary ? 'minor mercenary faction' : 'minor faction'
  }
  if (clan.isBandit) {
    return 'bandit faction'
  }
  if (clan.clanId === 'player_faction') {
    return 'player faction'
  }
  return 'faction'
}

function yesNo(value: unknown): string {
  return Number(value) ? 'yes' : 'no'
}
