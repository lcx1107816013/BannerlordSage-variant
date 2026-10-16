// Package toolset ports src/utils/bannerlord-toolset.ts: the two tool-name tiers and the mode that
// selects between them.
//
// ★ EVERY NAME IS WRITTEN IN ITS LEGACY FORM AND RUN THROUGH toolnaming.ArchiveToolName, which is
// the SAME helper the registration site uses. That is not tidiness — it is the fix for a real loss:
// a list written in current names would be a hand-maintained second copy of the naming rule, and a
// drifted copy is exactly how 16 registered tools once went unnoticed (finding F1 in the
// BannerScribe capability ledger). The TypeScript says the same thing above its lists.
package toolset

import (
	"strings"

	"blore/internal/report"
	"blore/internal/toolnaming"
)

// Mode mirrors BannerlordToolsetMode.
type Mode = string

const (
	// ModeQueryFirst mirrors 'query-first'.
	ModeQueryFirst Mode = "query-first"
	// ModeFull mirrors 'full'.
	ModeFull Mode = "full"
)

// LegacyGameplayToolNames mirrors LEGACY_GAMEPLAY_TOOL_NAMES — the 16 gameplay and memory
// registrations restored from upstream, in upstream order, in LEGACY form.
//
// ★ THEY BELONG TO THE QUERY-FIRST TIER because upstream registered them unconditionally. An
// earlier variant of the TypeScript had them in NEITHER list while the server still registered
// them, so the list disagreed with reality and the registry test passed only because it asserted
// the list against itself. The order below is the upstream order and is preserved for that reason.
var LegacyGameplayToolNames = []string{
	"project_memory_add",
	"project_memory_capture_session",
	"project_memory_search",
	"project_memory_recent",
	"project_memory_wakeup",
	"project_memory_invalidate",
	"trace_troop_tree",
	"get_item_stats",
	"get_clan_summary",
	"get_policy_summary",
	"get_hero_profile",
	"get_perk_data",
	"get_kingdom_summary",
	"get_culture_summary",
	"get_settlement_summary",
	"get_skill_data",
}

// queryFirstLegacy is the source order of the query-first list: the three status tools, then the 16
// restored ones, then the rest. The TypeScript spreads LEGACY_GAMEPLAY_TOOL_NAMES at that position,
// so the resulting ORDER differs from simply appending them — and order is observable, because the
// list is what callers iterate to register or audit tools.
var queryFirstLegacy = buildQueryFirstLegacy()

func buildQueryFirstLegacy() []string {
	head := []string{
		"bannerlord_doctor",
		"bannerlord_index_status",
		"bannerlord_editor_status",
	}
	tail := []string{
		"project_memory_read",
		"project_memory_write",
		"mod_source_status",
		"index_mod_source",
		"search_mod_source",
		"read_mod_file",
		"list_mod_directory",
		"read_mod_type",
		"read_csharp_type",
		"search_source",
		"read_file",
		"list_directory",
		"search_xml",
		"search_bannerlord_knowledge",
		"search_bannerlord_docs",
		"search_bannerlord_api_docs",
		"get_entity",
		"generate_harmony_patch",
		"resolve_localization",
		"read_gauntlet_ui",
		// Asset side, added by this project — upstream has no notion of assets, so there is
		// no upstream tier placement to preserve. Both are read-only and both answer a
		// question asked before anything is modified.
		"index_assets",
		"find_asset",
		"check_mod_conflicts",
	}
	out := make([]string, 0, len(head)+len(LegacyGameplayToolNames)+len(tail))
	out = append(out, head...)
	out = append(out, LegacyGameplayToolNames...)
	out = append(out, tail...)
	return out
}

// authoringLegacy is the source order of the authoring tier.
var authoringLegacy = []string{
	"create_mod_workspace",
	"generate_xslt_patch",
	"bannerlord_editor_entities",
	"bannerlord_editor_prefab_info",
	"bannerlord_editor_apply_layout",
	"bannerlord_editor_save_scene",
	"bannerlord_editor_capture",
}

// QueryFirstToolNames mirrors QUERY_FIRST_BANNERLORD_TOOL_NAMES: the legacy list mapped through
// ArchiveToolName.
//
// It is a slice built once at package load. A caller that needs to append must copy it first — Go
// slices share their backing array, and the TypeScript's `.map()` returns a fresh array, so a
// mutation here would be visible to every other caller in a way it would not be in the original.
var QueryFirstToolNames = mapAll(queryFirstLegacy)

// AuthoringToolNames mirrors AUTHORING_BANNERLORD_TOOL_NAMES.
var AuthoringToolNames = mapAll(authoringLegacy)

func mapAll(legacy []string) []string {
	out := make([]string, 0, len(legacy))
	for _, name := range legacy {
		out = append(out, toolnaming.ArchiveToolName(name))
	}
	return out
}

// GetMode mirrors getBannerlordToolsetMode.
//
// ★ ANYTHING THAT IS NOT EXACTLY "query-first" IS "full" — after the trim and lowercase. So an
// unset variable, an empty string, "full", and a typo ALL select the FULL set, which is the larger
// one: the default is the permissive side, not the restrictive one. A port that defaulted to
// query-first would silently hide the authoring tools.
//
// ★ THE TRIM IS JAVASCRIPT'S, NOT Go's. The measured ECMAScript set differs from unicode.IsSpace in
// both directions (it includes U+FEFF and excludes U+0085), so a value like "\uFEFFquery-first"
// selects query-first here while strings.TrimSpace would leave the BOM in place and select full.
func GetMode(lookupEnv func(string) (string, bool)) Mode {
	configured := ""
	if value, ok := lookupEnv("BANNERSAGE_TOOLSET"); ok {
		// ★ THE TRIM IS JAVASCRIPT'S, NOT Go's, so it comes from internal/report rather than from this
		// package (F25 — one implementation of the measured ECMAScript set, not two). The set differs from
		// unicode.IsSpace in both directions: it includes U+FEFF and excludes U+0085. A value like
		// "\uFEFFquery-first" therefore selects query-first, where strings.TrimSpace would leave the BOM in
		// place and select full.
		configured = strings.ToLower(report.TrimJS(value))
	}
	if configured == ModeQueryFirst {
		return ModeQueryFirst
	}
	return ModeFull
}

// GetActiveToolNames mirrors getActiveBannerlordToolNames: the query-first tier, or both tiers.
//
// The returned slice is a COPY, matching the TypeScript's spread (`[...QUERY_FIRST]`), so a caller
// cannot mutate the package-level list through it.
func GetActiveToolNames(lookupEnv func(string) (string, bool)) []string {
	if GetMode(lookupEnv) == ModeQueryFirst {
		out := make([]string, len(QueryFirstToolNames))
		copy(out, QueryFirstToolNames)
		return out
	}
	out := make([]string, 0, len(QueryFirstToolNames)+len(AuthoringToolNames))
	out = append(out, QueryFirstToolNames...)
	out = append(out, AuthoringToolNames...)
	return out
}
