// Culture lookup. Rows with the largest name pools (most useful for name
// generation) and an actual description sort first.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import { formatReferenceLabel, lookupPolicyName } from '../utils/bannerlord-entity-resolver'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getCultureSummary(cultureId: string) {
  const db = getDb()
  const cultureRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_cultures
      WHERE cultureId = $id
      ORDER BY
        (maleNameCount + femaleNameCount) DESC,
        CASE WHEN descriptionText IS NOT NULL AND descriptionText <> '' THEN 0 ELSE 1 END,
        filePath
    `
    )
    .all({ $id: cultureId })

  if (cultureRecords.length === 0) {
    return textOnly(`Culture not found: ${cultureId}`)
  }

  const blocks: AiTextBlock[] = cultureRecords.map((culture, position) => ({
    header: `culture_${position + 1}`,
    fields: [
      { key: 'source_path', value: culture.filePath },
      { key: 'culture_id', value: culture.cultureId },
      { key: 'display_name', value: resolveMaybeLocalizedText(culture.name) },
      { key: 'is_main_culture', value: culture.isMainCulture ? 'true' : 'false' },
      { key: 'can_have_settlement', value: culture.canHaveSettlement },
      { key: 'color_primary', value: culture.color },
      { key: 'color_secondary', value: culture.color2 },
      { key: 'basic_troop_ref', value: culture.basicTroop },
      { key: 'elite_basic_troop_ref', value: culture.eliteBasicTroop },
      { key: 'board_game_type', value: culture.boardGameType },
      { key: 'male_name_count', value: culture.maleNameCount },
      { key: 'female_name_count', value: culture.femaleNameCount },
      { key: 'default_policy_count', value: culture.defaultPolicyCount },
    ],
    listFields: [
      {
        key: 'default_policy_refs',
        values: resolvePolicyRefs(db, culture.defaultPolicyIdsJson),
      },
    ],
    multilineFields: [
      { key: 'description', value: culture.descriptionText ? resolveMaybeLocalizedText(culture.descriptionText) : null },
    ],
  }))

  return textOnly(renderAiTextReport('culture_summary', 'query_culture_id', cultureId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function textOnly(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** Maps each stored policy id to its display label, in stored order. */
function resolvePolicyRefs(db: ReturnType<typeof getDb>, rawIdsJson: string): string[] {
  return parseIdList(rawIdsJson).map(policyId => formatReferenceLabel(policyId, lookupPolicyName(db, policyId)))
}

/** Stored id lists are JSON arrays; anything unparseable or non-string drops out. */
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
