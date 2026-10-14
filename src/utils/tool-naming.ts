/**
 * Tool-name contract for BannerScribe Archive.
 *
 * WHY THIS IS AT THE REGISTRATION SITE
 * ------------------------------------
 * The rename to `ba_*` used to happen in the BannerScribe Core dispatch layer,
 * which meant this server still advertised its old names and only the aggregate
 * view looked renamed. Any client connecting to this server directly saw the old
 * surface, and a rename that exists in exactly one consumer is not a rename — it
 * is a translation table with one entry point. The prefix now lives here, at the
 * moment each tool is registered, so what this server advertises IS the contract.
 *
 * NOT AN ALIAS LAYER
 * ------------------
 * Old names are deliberately NOT also registered. Registering both would make
 * Core expose `ba_doctor` and, after its own pass, `ba_bannerlord_doctor` —
 * a doubled prefix, which is worse than either name alone. Callers that still
 * hold an old name must be updated; that is the cost of the rename, and hiding
 * it would defeat the purpose.
 */
export const ARCHIVE_PREFIX = 'ba_'

/** Upstream prefixes this module used before the BannerScribe rename. */
const LEGACY_PREFIXES = ['bannerlord_'] as const

/** `bannerlord_doctor` -> `ba_doctor`; `get_clan_summary` -> `ba_get_clan_summary`. */
export function archiveToolName(legacyName: string): string {
  let bare = legacyName
  for (const p of LEGACY_PREFIXES) {
    if (bare.startsWith(p)) {
      bare = bare.slice(p.length)
      break
    }
  }
  return ARCHIVE_PREFIX + bare
}

/**
 * Declare a tool's name in one place: returns the current name and its legacy
 * name, so registration, the toolset lists and the tests all agree by
 * construction instead of by three hand-edited strings.
 */
export function archiveTool(legacyName: string): { name: string; legacy: string } {
  return { name: archiveToolName(legacyName), legacy: legacyName }
}
