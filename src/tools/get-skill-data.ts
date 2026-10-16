// Skill lookup: renders the attribute modifiers that shape a skill as compact
// code|modification|value rows, and passes documentation text through verbatim.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'

type SkillModifier = {
  attribCode?: string | null
  modification?: string | null
  value?: string | null
}

export async function getSkillData(skillId: string) {
  const db = getDb()
  const skillRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_skills
      WHERE skillId = $id
      ORDER BY filePath
    `
    )
    .all({ $id: skillId })

  if (skillRecords.length === 0) {
    return asTextReply(`Skill data not found: ${skillId}`)
  }

  const blocks: AiTextBlock[] = skillRecords.map((skillRecord, position) => ({
    header: `skill_${position + 1}`,
    fields: [
      { key: 'source_path', value: skillRecord.filePath },
      { key: 'skill_id', value: skillRecord.skillId },
      { key: 'display_name', value: skillRecord.name },
      { key: 'modifier_count', value: skillRecord.modifierCount },
    ],
    listFields: [
      {
        key: 'modifiers',
        values: parseModifiers(skillRecord.modifiersJson).map(formatModifierRow),
      },
    ],
    multilineFields: [{ key: 'documentation', value: skillRecord.documentation }],
  }))

  return asTextReply(renderAiTextReport('skill_data', 'query_skill_id', skillId, blocks))
}

/** Wraps one rendered report in the single-text-content reply shape. */
function asTextReply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/** One modifier as a `key=value` triple; a blank or absent part reads "unknown". */
function formatModifierRow(modifier: SkillModifier): string {
  const attribCode = modifier.attribCode || 'unknown'
  const modification = modifier.modification || 'unknown'
  const value = modifier.value || 'unknown'
  return `attrib_code=${attribCode} | modification=${modification} | value=${value}`
}

function parseModifiers(raw: string): SkillModifier[] {
  let decoded: unknown
  try {
    decoded = JSON.parse(raw)
  } catch {
    return []
  }
  return Array.isArray(decoded) ? decoded : []
}
