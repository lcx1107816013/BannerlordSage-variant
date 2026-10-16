// Item and crafting-piece lookup. One entity id can cover several rows
// (item vs crafted piece vs crafting piece), so the entity kind appears in
// the block header and the stat columns cover all three shapes.
import { getDb } from '../utils/db'
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import { resolveMaybeLocalizedText } from '../utils/localization'

// The stat columns are one long ordered list; the order is the report's, so
// it stays literal rather than being derived.
const STAT_COLUMNS: string[] = [
  'itemType',
  'weight',
  'value',
  'weaponLength',
  'swingDamage',
  'swingDamageType',
  'thrustDamage',
  'thrustDamageType',
  'speedRating',
  'balanceOrHitPoints',
  'headArmor',
  'bodyArmor',
  'legArmor',
  'armArmor',
  'horseChargeDamage',
  'horseSpeed',
  'horseManeuver',
  'tier',
  'pieceType',
  'length',
  'materialCount',
]

// The report's snake_case key for each column above, positionally aligned.
const STAT_KEYS: string[] = [
  'item_type',
  'weight',
  'value',
  'weapon_length',
  'swing_damage',
  'swing_damage_type',
  'thrust_damage',
  'thrust_damage_type',
  'speed_rating',
  'balance_or_hit_points',
  'head_armor',
  'body_armor',
  'leg_armor',
  'arm_armor',
  'horse_charge_damage',
  'horse_speed',
  'horse_maneuver',
  'tier',
  'piece_type',
  'piece_length',
  'material_count',
]

export async function getItemStats(itemId: string) {
  const db = getDb()
  const itemRecords = db
    .query<any, any>(
      `
      SELECT *
      FROM bannerlord_items
      WHERE entityId = $id
      ORDER BY entityKind, filePath
    `
    )
    .all({ $id: itemId })

  if (itemRecords.length === 0) {
    return replyWithText(`Item or crafting piece not found: ${itemId}`)
  }

  const blocks: AiTextBlock[] = itemRecords.map((item, position) => ({
    header: `${item.entityKind || 'entity'}_${position + 1}`,
    fields: [
      { key: 'source_path', value: item.filePath },
      { key: 'entity_kind', value: item.entityKind },
      { key: 'entity_id', value: item.entityId },
      { key: 'display_name', value: resolveMaybeLocalizedText(item.name) },
      ...STAT_KEYS.map((key, index) => ({ key, value: item[STAT_COLUMNS[index]] })),
    ],
  }))

  return replyWithText(renderAiTextReport('item_stats', 'query_item_id', itemId, blocks))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function replyWithText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
