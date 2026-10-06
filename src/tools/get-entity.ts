import { getClanSummary } from './get-clan-summary'
import { getCultureSummary } from './get-culture-summary'
import { getHeroProfile } from './get-hero-profile'
import { getItemStats } from './get-item-stats'
import { getKingdomSummary } from './get-kingdom-summary'
import { getPerkData } from './get-perk-data'
import { getPolicySummary } from './get-policy-summary'
import { getSettlementSummary } from './get-settlement-summary'
import { getSkillData } from './get-skill-data'
import { traceTroopTree } from './trace-troop-tree'

export const GAMEPLAY_ENTITY_KINDS = [
  'clan',
  'culture',
  'hero',
  'item',
  'kingdom',
  'perk',
  'policy',
  'settlement',
  'skill',
  'troop',
] as const

export type GameplayEntityKind = (typeof GAMEPLAY_ENTITY_KINDS)[number]

/** Single entry point for the precomputed gameplay projection tables. */
export async function getEntity(kind: GameplayEntityKind, id: string) {
  switch (kind) {
    case 'clan':
      return await getClanSummary(id)
    case 'culture':
      return await getCultureSummary(id)
    case 'hero':
      return await getHeroProfile(id)
    case 'item':
      return await getItemStats(id)
    case 'kingdom':
      return await getKingdomSummary(id)
    case 'perk':
      return await getPerkData(id)
    case 'policy':
      return await getPolicySummary(id)
    case 'settlement':
      return await getSettlementSummary(id)
    case 'skill':
      return await getSkillData(id)
    case 'troop':
      return await traceTroopTree(id)
  }
}
