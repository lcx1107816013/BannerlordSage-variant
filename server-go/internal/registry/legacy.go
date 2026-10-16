package registry

import (
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/toolnaming"
)

// ─────────────────────────────────────────────────────────────────────────────
// The 16 restored gameplay + memory tools — src/tools/legacy-registrations.ts
//
// These registrations are the upstream blocks restored verbatim (upstream @8311c9a),
// after our own commit b80b55f wrongly removed them ("16 tools that were never
// registered" — they were). They belong to the QUERY-FIRST tier: upstream registered
// them unconditionally, so the mode only ever gated the authoring tools. The Go side
// mirrors that: this function is called in both modes.
//
// None of the 16 has a Go body yet:
//   - the 6 project-memory tools wait on project-memory.ts (680 lines)
//   - the 10 gameplay tools reach gameplay.GetEntity etc., but the TS bodies call
//     getDb() and pass NO preferred-language list; the Go equivalents need the db
//     handle and a nil preferred slice. The wiring is trivial once the Deps contract
//     settles, but binding them here without the runtimecheck gate would let the Go
//     server open dist/games/bannerlord/bannerlord.db before the readiness probe
//     has run — the TS stdio entry bails when uninitialized, and the Go one must too
//     before these go live.
// ─────────────────────────────────────────────────────────────────────────────

func registerLegacyGameplayTools(server *mcp.Server, _ *Deps) {
	registerProjectMemoryTools(server)
	registerGameplayQueryTools(server)
}

func registerProjectMemoryTools(server *mcp.Server) {
	addSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text":      prop("string", "The raw memory text to preserve. Prefer verbatim reasoning, decisions, and concrete findings."),
			"workspace": prop("string", "Optional project or workspace scope, such as bannerlordsage or a specific mod name. Defaults to bannerlordsage."),
			"topic":     prop("string", "Optional topic bucket, such as indexing, docs, harmony, release, or xml."),
			"kind":      prop("string", "Optional memory kind such as decision, pitfall, preference, todo, session, or note."),
			"summary":   prop("string", "Optional one-line summary for quick scanning."),
			"source":    prop("string", "Optional source reference such as a file path, issue id, or session label."),
			"tags": map[string]any{
				"type": "array", "items": map[string]any{"type": "string"},
				"description": "Optional short tags for filtering and recall.",
			},
			"importance": propWithDefault("number", 3, "Importance from 1 to 5. Higher values are better wake-up candidates."),
		},
		"required": []string{"text"},
	}
	register(server, "project_memory_add", "Add Project Memory",
		"Use this to store a durable project memory such as a decision, pitfall, preference, todo, or session outcome. This is the BannerlordSage-native memory layer for cross-session continuity.",
		writable(), addSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_add"))))

	captureSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"workspace": prop("string", "Optional project or workspace scope, such as bannerlordsage or a specific mod name. Defaults to bannerlordsage."),
			"topic":     prop("string", "Optional topic bucket such as memory, indexing, harmony, validation, or docs."),
			"source":    prop("string", "Optional source reference such as a file path, issue id, or session label."),
			"summary":   prop("string", "Optional concise session summary for future wake-up context."),
			"decisions": strArray("Durable design or implementation decisions from this session."),
			"pitfalls":  strArray("Confirmed bugs, traps, compatibility hazards, or rejected paths worth remembering."),
			"preferences": strArray(
				"Stable user or project preferences made explicit in this session."),
			"todos": strArray("Durable follow-up tasks or pending constraints that should survive context loss."),
			"notes": strArray("Other reusable notes from this session that do not fit the stricter categories."),
			"sessionImportance": propWithDefault("number", 3,
				"Importance from 1 to 5 for the optional session summary entry."),
		},
	}
	register(server, "project_memory_capture_session", "Capture Session Memory",
		"Use this near the end of a meaningful task to batch-store the durable conclusions from the session. It is the preferred write path for decisions, pitfalls, preferences, todos, and the concise session summary.",
		writable(), captureSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_capture_session"))))

	searchSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query":           prop("string", "Search text describing the past decision, issue, preference, or context you want to recall."),
			"workspace":       prop("string", "Optional workspace or project filter."),
			"topic":           prop("string", "Optional topic filter."),
			"kind":            prop("string", "Optional kind filter such as decision, pitfall, or preference."),
			"limit":           propWithDefault("number", 5, "Maximum number of memories to return."),
			"includeInactive": propWithDefault("boolean", false, "When true, include invalidated memories in the results."),
		},
		"required": []string{"query"},
	}
	register(server, "project_memory_search", "Search Project Memory",
		"Use this before answering questions about past project decisions, preferences, pitfalls, or prior session conclusions. It searches BannerlordSage-native project memory with full-text matching and metadata filters.",
		readOnly(), searchSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_search"))))

	recentSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"workspace":       prop("string", "Optional workspace or project filter."),
			"topic":           prop("string", "Optional topic filter."),
			"kind":            prop("string", "Optional kind filter."),
			"limit":           propWithDefault("number", 8, "Maximum number of memories to return."),
			"includeInactive": propWithDefault("boolean", false, "When true, include invalidated memories."),
		},
	}
	register(server, "project_memory_recent", "Recent Project Memory",
		"Use this to review the latest stored project memories for a workspace or topic, especially when resuming work after a break.",
		readOnly(), recentSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_recent"))))

	wakeupSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"workspace": prop("string", "Optional workspace or project filter."),
			"limit":     propWithDefault("number", 8, "Maximum number of wake-up memories to return."),
		},
	}
	register(server, "project_memory_wakeup", "Project Memory Wake-up",
		"Use this at the start of a coding session to load the most important active project memories for a workspace, biased toward decisions, pitfalls, and preferences.",
		readOnly(), wakeupSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_wakeup"))))

	invalidateSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"memoryId": prop("string", "Exact memory id returned by the project memory tools."),
			"reason":   prop("string", "Optional reason explaining why the memory is no longer valid."),
		},
		"required": []string{"memoryId"},
	}
	register(server, "project_memory_invalidate", "Invalidate Project Memory",
		"Use this when an older project memory is no longer valid because the design changed, a decision was reversed, or a previous conclusion was disproven.",
		writable(), invalidateSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_invalidate"))))
}

// strArray builds an optional string-array property.
func strArray(description string) map[string]any {
	return map[string]any{
		"type":        "array",
		"items":       map[string]any{"type": "string"},
		"description": description,
	}
}

func registerGameplayQueryTools(server *mcp.Server) {
	register(server, "trace_troop_tree", "Trace Troop Tree",
		"Use this when you already know a troop character ID and want a focused upgrade-tree summary without manually traversing NPCCharacter XML. This reads the precomputed troop projection table, so it is faster and more reliable than reparsing XML fragments for each request.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"characterId": prop("string", "Exact troop ID such as vlandian_recruit or imperial_infantryman."),
			},
			"required": []string{"characterId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("trace_troop_tree"))))

	register(server, "get_item_stats", "Get Item Stats",
		"Use this when you already know an item ID or crafting-piece ID and need a condensed gameplay-facing summary. Prefer this over raw XML reading for weapons, armor, horses, and smithing parts because it reads the precomputed item projection table and formats the key stats directly.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"itemId": prop("string", "Exact item or crafting piece ID, for example saddle_horse or sword_blade_4_t3."),
			},
			"required": []string{"itemId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_item_stats"))))

	register(server, "get_clan_summary", "Get Clan Summary",
		"Use this when you already know a clan or faction ID from spclans.xml and want its resolved culture, owner hero, home settlement, and super-faction without manually joining multiple XML files. This reads the precomputed clan projection table and is especially useful for noble clans, minor factions, mercenaries, and bandit groups.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"clanId": prop("string", "Exact clan or faction ID such as clan_empire_north_3, player_faction, or ghilman."),
			},
			"required": []string{"clanId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_clan_summary"))))

	register(server, "get_policy_summary", "Get Policy Summary",
		"Use this when you know a kingdom policy ID and want the fully resolved policy text, support weights, current active kingdoms, and default cultures without manually stitching source-defined policy objects to XML kingdom and culture references. This reads the hybrid gameplay index built from both decompiled source and XML projections.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"policyId": prop("string", "Exact policy ID such as policy_feudal_inheritance or policy_royal_privilege."),
			},
			"required": []string{"policyId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_policy_summary"))))

	register(server, "get_hero_profile", "Get Hero Profile",
		"Use this when you already know a hero ID and want the merged relationship and character summary without manually joining Heroes XML and NPCCharacter XML. This reads the precomputed hero projection table and joins it with indexed troop data.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"heroId": prop("string", "Exact hero ID such as lord_1_1 or main_hero."),
			},
			"required": []string{"heroId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_hero_profile"))))

	register(server, "get_perk_data", "Get Perk Data",
		"Use this when you know a single-player perk ID and want its skill tree placement, paired alternative perk, role bonuses, increment types, and localized descriptions without searching the large DefaultPerks source file manually. This reads the hybrid gameplay index extracted from decompiled campaign source.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"perkId": prop("string", "Exact perk ID such as OneHandedWrappedHandles, BowBowControl, or LeadershipFerventAttacker."),
			},
			"required": []string{"perkId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_perk_data"))))

	register(server, "get_kingdom_summary", "Get Kingdom Summary",
		"Use this when you know a kingdom ID and want a focused summary of ruler, culture, capital/home settlement, colors, and policy counts without reparsing spkingdoms.xml. This reads the precomputed kingdom projection table.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kingdomId": prop("string", "Exact kingdom ID such as empire, battania, or aserai."),
			},
			"required": []string{"kingdomId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_kingdom_summary"))))

	register(server, "get_culture_summary", "Get Culture Summary",
		"Use this when you already know a culture ID and want a fast summary of core culture metadata, localized description text, troop roots, and name pools. This reads the precomputed culture projection table instead of reparsing the large cultures XML file.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cultureId": prop("string", "Exact culture ID such as empire, battania, or khuzait."),
			},
			"required": []string{"cultureId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_culture_summary"))))

	register(server, "get_settlement_summary", "Get Settlement Summary",
		"Use this when you know a settlement ID and want a fast summary of settlement type, owner faction, derived kingdom, village bindings, scenes, and prosperity/hearth values. This reads the precomputed settlement projection table instead of reparsing settlements.xml and related faction XML.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"settlementId": prop("string", "Exact settlement ID such as town_B1, castle_EN1, or castle_village_EN1_1."),
			},
			"required": []string{"settlementId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_settlement_summary"))))

	register(server, "get_skill_data", "Get Skill Data",
		"Use this when you know a skill XML ID and want its modifier list and documentation without opening the full skills XML. This reads the precomputed skill projection table and is best for quickly understanding attribute modifiers.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"skillId": prop("string", "Exact skill XML ID such as IronFlesh1 or PowerStrike1."),
			},
			"required": []string{"skillId"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_skill_data"))))
}
