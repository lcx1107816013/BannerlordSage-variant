// Policy lookup. Ids go through the normalizer first (game data uses
// several spellings for the same policy); the normalized id is echoed back
// as a footnote so callers can see the mapping that was applied.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import {
  formatReferenceLabel,
  lookupCultureName,
  lookupKingdomInfo,
} from '../utils/bannerlord-entity-resolver'
import { normalizeBannerlordPolicyId } from '../utils/bannerlord-policy-id'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getPolicySummary(policyId: string) {
  const db = getDb()
  const normalizedPolicyId = normalizeBannerlordPolicyId(policyId) ?? policyId
  const policyRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_policies
      WHERE policyId = $policyId
      LIMIT 1
    `
    )
    .all({ $policyId: normalizedPolicyId })

  if (policyRecords.length === 0) {
    return asText(`Policy not found: ${policyId}`)
  }

  const blocks: AiTextBlock[] = policyRecords.map((policy, position) => ({
    header: `policy_${position + 1}`,
    fields: [
      { key: 'source_path', value: policy.filePath },
      { key: 'policy_id', value: policy.policyId },
      { key: 'source_object_id', value: policy.rawPolicyId },
      { key: 'source_module', value: policy.sourceModule },
      { key: 'display_name', value: policy.displayName ? resolveMaybeLocalizedText(policy.displayName) : null },
      { key: 'ruler_support', value: policy.rulerSupport },
      { key: 'lords_support', value: policy.lordsSupport },
      { key: 'commons_support', value: policy.commonsSupport },
      { key: 'active_kingdom_count', value: policy.activeKingdomCount },
      { key: 'default_culture_count', value: policy.defaultCultureCount },
    ],
    listFields: [
      { key: 'active_kingdom_refs', values: kingdomRefs(db, policy.activeKingdomIdsJson) },
      { key: 'default_culture_refs', values: cultureRefs(db, policy.defaultCultureIdsJson) },
    ],
    multilineFields: [
      { key: 'description', value: optionalLocalized(policy.descriptionText) },
      { key: 'proposal_text', value: optionalLocalized(policy.proposalText) },
      { key: 'effect_summary', value: optionalLocalized(policy.effectsText) },
    ],
  }))

  return asText(
    renderAiTextReport('policy_summary', 'query_policy_id', policyId, blocks, [
      { key: 'normalized_policy_id', value: normalizedPolicyId },
    ])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function asText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** A stored, possibly-empty text renders only when the column has a value. */
function optionalLocalized(stored: string | null): string | null {
  return stored ? resolveMaybeLocalizedText(stored) : null
}

/** The policy's active kingdoms, each with its resolved kingdom name. */
function kingdomRefs(db: ReturnType<typeof getDb>, rawIdsJson: string): string[] {
  return parseIdList(rawIdsJson).map(kingdomId => {
    const kingdom = lookupKingdomInfo(db, kingdomId)
    return formatReferenceLabel(kingdomId, kingdom?.name)
  })
}

/** The policy's default cultures, each with its resolved culture name. */
function cultureRefs(db: ReturnType<typeof getDb>, rawIdsJson: string): string[] {
  return parseIdList(rawIdsJson).map(cultureId =>
    formatReferenceLabel(cultureId, lookupCultureName(db, cultureId))
  )
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
