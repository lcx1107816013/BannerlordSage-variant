import { archiveToolName } from './tool-naming'
import { LEGACY_GAMEPLAY_TOOL_NAMES } from '../tools/legacy-registrations'

export type BannerlordToolsetMode = 'query-first' | 'full'

/**
 * The canonical, CURRENT tool name lists.
 *
 * Every entry is written in its LEGACY form and passed through archiveToolName(),
 * the same helper server.ts registers with. That is deliberate: a list written
 * in current names would be a second, hand-maintained copy of the naming rule,
 * and a drifted copy is exactly how 16 registered tools once went unnoticed
 * (finding F1 in the BannerScribe capability ledger).
 */
export const QUERY_FIRST_BANNERLORD_TOOL_NAMES = [
  'bannerlord_doctor',
  'bannerlord_index_status',
  'bannerlord_editor_status',
  // ── legacy gameplay + memory tools restored from upstream @8311c9a ──────
  // Listed INSIDE the query-first tier because upstream registered them
  // unconditionally. An earlier variant had them in neither list while
  // server.ts still registered them, so this list disagreed with reality and
  // the registry test only passed because it asserted the list against itself.
  ...LEGACY_GAMEPLAY_TOOL_NAMES,
  'project_memory_read',
  'project_memory_write',
  'mod_source_status',
  'index_mod_source',
  'search_mod_source',
  'read_mod_file',
  'list_mod_directory',
  'read_mod_type',
  'read_csharp_type',
  'search_source',
  'read_file',
  'list_directory',
  'search_xml',
  'search_bannerlord_knowledge',
  'search_bannerlord_docs',
  'search_bannerlord_api_docs',
  'get_entity',
  'generate_harmony_patch',
  'resolve_localization',
  'read_gauntlet_ui',
].map(archiveToolName)

export const AUTHORING_BANNERLORD_TOOL_NAMES = [
  'create_mod_workspace',
  'generate_xslt_patch',
  'bannerlord_editor_entities',
  'bannerlord_editor_prefab_info',
  'bannerlord_editor_apply_layout',
  'bannerlord_editor_save_scene',
  'bannerlord_editor_capture',
].map(archiveToolName)

export function getBannerlordToolsetMode(): BannerlordToolsetMode {
  const configured = process.env.BANNERSAGE_TOOLSET?.trim().toLowerCase()
  return configured === 'query-first' ? 'query-first' : 'full'
}

export function getActiveBannerlordToolNames(): string[] {
  if (getBannerlordToolsetMode() === 'query-first') {
    return [...QUERY_FIRST_BANNERLORD_TOOL_NAMES]
  }

  return [...QUERY_FIRST_BANNERLORD_TOOL_NAMES, ...AUTHORING_BANNERLORD_TOOL_NAMES]
}
