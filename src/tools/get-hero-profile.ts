// Hero lookup joined with the underlying troop record: one row covers the
// hero's campaign identity (family, spouse, alive flag) plus the troop-level
// presentation (name, culture, occupation).
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import { resolveMaybeLocalizedText } from '../utils/localization'

export async function getHeroProfile(heroId: string) {
  const db = getDb()
  const profileRows = db
    .query<any, any>(
      `
      SELECT
        h.*,
        t.name AS troopName,
        t.culture AS troopCulture,
        t.occupation AS troopOccupation,
        t.skillTemplate AS troopSkillTemplate,
        t.isFemale AS troopIsFemale
      FROM bannerlord_heroes h
      LEFT JOIN bannerlord_troops t
        ON t.characterId = h.heroId
      WHERE h.heroId = $id
      ORDER BY h.filePath, t.filePath
    `
    )
    .all({ $id: heroId })

  if (profileRows.length === 0) {
    return wrapText(`Hero not found: ${heroId}`)
  }

  const blocks: AiTextBlock[] = profileRows.map((profile, position) => ({
    header: `hero_${position + 1}`,
    fields: [
      { key: 'source_path', value: profile.filePath },
      { key: 'hero_id', value: profile.heroId },
      { key: 'display_name', value: resolveMaybeLocalizedText(profile.troopName) },
      { key: 'faction_ref', value: profile.faction },
      { key: 'clan_ref', value: profile.clan },
      { key: 'culture_ref', value: profile.troopCulture },
      { key: 'occupation', value: profile.troopOccupation },
      { key: 'alive', value: describeAliveFlag(profile.alive) },
      { key: 'is_template', value: profile.isTemplate ? 'true' : 'false' },
      { key: 'gender', value: profile.troopIsFemale ? 'female' : 'male_or_unspecified' },
      { key: 'skill_template', value: profile.troopSkillTemplate },
      { key: 'spouse_ref', value: profile.spouse },
      { key: 'father_ref', value: profile.father },
      { key: 'mother_ref', value: profile.mother },
    ],
    multilineFields: [
      { key: 'biography', value: profile.text ? resolveMaybeLocalizedText(profile.text) : null },
    ],
  }))

  return wrapText(renderAiTextReport('hero_profile', 'query_hero_id', heroId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function wrapText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * The stored flag is a text column that may be absent. An absent value means
 * the hero record predates the column, so it reads as alive; only an explicit
 * "false" (in any casing) flips it.
 */
function describeAliveFlag(stored: string | null): string {
  if (!stored) {
    return 'yes'
  }
  const isDead = stored.toLowerCase() === 'false'
  return isDead ? 'no' : 'yes'
}
