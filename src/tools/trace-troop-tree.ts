// Walks a troop's upgrade chain: resolves one character id and lists the
// ids it can promote into, next to the troop's identity and classification.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function traceTroopTree(characterId: string) {
  const db = getDb()
  const troopRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_troops
      WHERE characterId = $id
      ORDER BY filePath
    `
    )
    .all({ $id: characterId })

  if (troopRecords.length === 0) {
    return oneTextContent(`Troop not found: ${characterId}`)
  }

  const blocks: AiTextBlock[] = troopRecords.map((troop, position) => ({
    header: `troop_${position + 1}`,
    fields: [
      { key: 'source_path', value: troop.filePath },
      { key: 'character_id', value: troop.characterId },
      { key: 'display_name', value: resolveMaybeLocalizedText(troop.name) },
      { key: 'level', value: troop.level },
      { key: 'culture_ref', value: troop.culture },
      { key: 'occupation', value: troop.occupation },
      { key: 'skill_template', value: troop.skillTemplate || 'custom' },
      { key: 'is_hero', value: flagToText(troop.isHero) },
      { key: 'is_female', value: flagToText(troop.isFemale) },
    ],
    listFields: [
      {
        key: 'upgrade_target_ids',
        values: parseUpgradeTargets(troop.upgradeTargetsJson),
      },
    ],
  }))

  return oneTextContent(renderAiTextReport('troop_tree', 'query_character_id', characterId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function oneTextContent(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** SQLite hands these back as 0/1, so the text form is a numeric truth test. */
function flagToText(value: unknown): string {
  return Number(value) ? 'true' : 'false'
}

function parseUpgradeTargets(raw: string): string[] {
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
