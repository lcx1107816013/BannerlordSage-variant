package registry

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/env"
	"blore/internal/toolnaming"
)

// ─────────────────────────────────────────────────────────────────────────────
// The main-file registrations — src/server.ts
//
// Handled here in the TS file's own order. Tools whose Go bodies exist bind to
// them; the rest stub. The bound ones are:
//
//   generate_xslt_patch          tools.GenerateXsltPatch   (full mode only)
//   read_csharp_type             tools.ReadCsharpType      (+ db + sourcePath from Deps)
//   search_source                tools.SearchSource
//   read_file / list_directory   tools.ReadFile / ListDirectory
//   search_xml                   tools.SearchXML
//   search_bannerlord_docs       tools.SearchDocs
//   search_bannerlord_api_docs   tools.SearchAPIDocs
//   get_entity                   gameplay.GetEntity
//   generate_harmony_patch       — arriving with route C below; stub until then
//   resolve_localization         tools.ResolveLocalization
//   read_gauntlet_ui             tools.ReadGauntletUI
//   list_mod_directory           tools.ListModDirectory
//   read_mod_file                tools.ReadModFile
//   search_mod_source / mod_source_status / read_mod_type — route D; stub until then
//   search_bannerlord_knowledge  — route A; stub until then
//   bannerlord_index_status      — route B; stub until then
//   bannerlord_doctor            — needs moduletooling's file-system half; stub
//   project_memory_read/write    — project-memory.ts pending; stub
//   create_mod_workspace         — 884-line monolith; stub (full mode only)
// ─────────────────────────────────────────────────────────────────────────────

func registerMainTools(server *mcp.Server, deps *Deps) {
	registerDoctor(server)
	registerIndexStatus(server)
	registerProjectMemoryRW(server)
	registerModSourceTools(server)
	registerCreateModWorkspace(server, deps)
	registerReadCsharpType(server, deps)
	registerSearchSource(server, deps)
	registerReadFile(server, deps)
	registerListDirectory(server, deps)
	registerSearchXML(server, deps)
	registerSearchKnowledge(server, deps)
	registerSearchDocs(server, deps)
	registerSearchAPIDocs(server, deps)
	registerGetEntity(server, deps)
	registerGenerateHarmonyPatch(server, deps)
	registerGenerateXsltPatch(server, deps)
	registerResolveLocalization(server, deps)
	registerReadGauntletUI(server, deps)
	// Asset side: this project's own capability, absent upstream.
	registerIndexAssets(server, deps)
	registerFindAsset(server, deps)
}

func registerDoctor(server *mcp.Server) {
	register(server, "bannerlord_doctor", "Bannerlord Doctor",
		"Scan a real Bannerlord install for module dependency problems, duplicate libraries, missing SubModule DLLs, bad load order. Reads the live install directory, not the imported index. Returns focused issues and a recommended load order.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"gameDir":                prop("string", "Install path. Defaults to saved setup state."),
				"moduleId":               prop("string", "Exact module id, e.g. MercenaryGuild."),
				"modulePath":             prop("string", "Absolute module dir; use for duplicate ids."),
				"includeOfficialDetails": propWithDefault("boolean", false, "Include official module details."),
			},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_doctor"))))
}

func registerIndexStatus(server *mcp.Server) {
	register(server, "bannerlord_index_status", "Bannerlord Index Status",
		"Inspect BannerlordSage runtime state: active scopes, indexed table counts, XML parse failures, missing DLL coverage, toolset mode.",
		readOnly(), map[string]any{"type": "object", "properties": map[string]any{}},
		stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_index_status"))))
}

func registerProjectMemoryRW(server *mcp.Server) {
	writeSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": enumProp([]string{"add", "capture_session", "invalidate"},
				"add needs text; invalidate needs memoryId; capture_session batch-stores session conclusions."),
			"text":       prop("string", "Memory text (required for add). Prefer verbatim decisions and findings."),
			"memoryId":   prop("string", "Memory id (required for invalidate)."),
			"reason":     prop("string", "Why the memory is obsolete."),
			"workspace":  prop("string", "Workspace scope. Defaults to bannerlordsage."),
			"topic":      prop("string", "Topic bucket, e.g. indexing, harmony, xml."),
			"kind":       prop("string", "Memory kind, e.g. decision, pitfall, preference, todo."),
			"summary":    prop("string", "One-line summary."),
			"source":     prop("string", "Source reference, e.g. file path or session label."),
			"tags":       strArray("Short tags for recall."),
			"importance": prop("number", "1-5 (default 3). Higher is a better wake-up candidate."),
			"decisions":  strArray("capture_session: durable decisions."),
			"pitfalls":   strArray("capture_session: confirmed bugs and traps."),
			"preferences": strArray(
				"capture_session: stable preferences."),
			"todos": strArray("capture_session: pending follow-ups."),
			"notes": strArray("capture_session: other reusable notes."),
			"sessionImportance": prop("number",
				"capture_session: 1-5 (default 3)."),
		},
		"required": []string{"action"},
	}
	register(server, "project_memory_write", "Write Project Memory",
		"Write to the cross-session project memory layer. add: store one memory; capture_session: batch-store session conclusions; invalidate: mark a memory obsolete.",
		writable(), writeSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_write"))))

	readSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": enumProp([]string{"search", "recent", "wakeup"},
				"search needs query; recent lists newest; wakeup loads top-priority active memories."),
			"query":           prop("string", "Search text (required for search)."),
			"workspace":       prop("string", "Workspace or project filter."),
			"topic":           prop("string", "Topic filter, e.g. indexing, harmony, xml."),
			"kind":            prop("string", "Kind filter, e.g. decision, pitfall, preference."),
			"limit":           prop("number", "Max entries (default 5 search / 8 recent,wakeup)."),
			"includeInactive": propWithDefault("boolean", false, "Include invalidated memories."),
		},
		"required": []string{"action"},
	}
	register(server, "project_memory_read", "Read Project Memory",
		"Read the cross-session project memory layer. search: full-text query, use before claiming project history; recent: newest entries; wakeup: top-priority active entries at session start.",
		readOnly(), readSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("project_memory_read"))))
}

func registerModSourceTools(server *mcp.Server) {
	workspaceRootProp := prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.")

	statusSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"workspaceRoot": workspaceRootProp},
	}
	register(server, "mod_source_status", "Local Mod Source Status",
		"Inspect a local mod source workspace: resolved source root and indexed type/member counts.",
		readOnly(), statusSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("mod_source_status"))))

	register(server, "index_mod_source", "Index Local Mod Source",
		"Build or refresh the incremental C# index for a local mod source dir (reindexes only changed files).",
		readOnly(), map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspaceRoot": workspaceRootProp},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("index_mod_source"))))

	register(server, "search_mod_source", "Search Local Mod Source",
		"ripgrep over your local mod source tree (not the imported decompile tree). Fastest for frequently edited mod code.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": workspaceRootProp,
				"query":         prop("string", "Keyword or regex."),
				"caseSensitive": propWithDefault("boolean", false, "Case-sensitive search."),
				"filePattern":   prop("string", "Glob filter, e.g. *.cs or *Patch*.cs."),
			},
			"required": []string{"query"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_mod_source"))))

	register(server, "read_mod_file", "Read Local Mod File",
		"Read a line slice from your local mod source tree (live files, edits visible immediately).",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": workspaceRootProp,
				"path":          prop("string", "Path relative to source root."),
				"startLine":     propWithDefault("number", 0, "Zero-based start line."),
				"lineCount":     propWithDefault("number", 400, "Max lines."),
			},
			"required": []string{"path"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("read_mod_file"))))

	register(server, "list_mod_directory", "List Local Mod Directory",
		"List files and subdirs under your local mod source workspace.",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": workspaceRootProp,
				"path":          propWithDefault("string", "", "Dir relative to source root."),
			},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("list_mod_directory"))))

	register(server, "read_mod_type", "Read Local Mod Type",
		"Read a class/struct/interface/enum definition from your local mod source (cache refreshes on change).",
		readOnly(), map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": workspaceRootProp,
				"typeName":      prop("string", "Exact type name, e.g. SubModule."),
			},
			"required": []string{"typeName"},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("read_mod_type"))))
}

// registerCreateModWorkspace and registerGenerateXsltPatch are FULL-MODE ONLY in the
// TypeScript (`if (bannerlordToolsetMode === 'full')`). They are called from
// registerAuthoringTools, not from registerMainTools.
func registerCreateModWorkspace(server *mcp.Server, _ *Deps) {
	// Deliberately empty: the registration happens in registerAuthoringTools. The
	// signature keeps the deps for the day the 884-line body lands.
}

func registerReadCsharpType(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"typeName": prop("string", "Exact type name, e.g. MobileParty or Hero."),
		},
		"required": []string{"typeName"},
	}
	register(server, "read_csharp_type", "Read C# Type",
		"Get the decompiled definition of a known Bannerlord type. Prefer over text search for classes/structs/enums.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("read_csharp_type"))))
}

func registerSearchSource(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query":       prop("string", "Keyword or regex. Keep narrow, e.g. CalculateSpeed."),
			"filePattern": prop("string", "Glob filter, e.g. *.cs or */CampaignSystem/*.cs."),
		},
		"required": []string{"query"},
	}
	register(server, "search_source", "Search Decompiled Source",
		"ripgrep the decompiled C# source tree. Use when the exact type/method location is unknown.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_source"))))
}

func registerReadFile(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": prop("string", "Path relative to dist/games/"+env.ActiveGameID()+"/assets, e.g. Xmls/Modules/Native/ModuleData/crafting_pieces.xml."),
			"startLine": propWithDefault("number", 0,
				"Zero-based start line."),
			"lineCount": propWithDefault("number", 400, "Max lines."),
		},
		"required": []string{"path"},
	}
	register(server, "read_file", "Read Indexed File Slice",
		"Read a slice of an indexed source or XML file. Read only the relevant region to save context.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("read_file"))))
}

func registerListDirectory(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"path": propWithDefault("string", "", "Dir relative to assets root; empty lists top level."),
		},
	}
	register(server, "list_directory", "List Indexed Directory",
		"Explore what has been imported into dist/games/"+env.ActiveGameID()+"/assets before opening a file.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("list_directory"))))
}

func registerSearchXML(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": prop("string", "1-4 focused keywords."),
		},
		"required": []string{"query"},
	}
	register(server, "search_xml", "Search XML Data",
		"Full-text lookup across imported XML (ModuleData, Languages). Find which files mention an entity or token.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_xml"))))
}

func registerSearchKnowledge(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": prop("string", "Natural-language request, e.g. \"我要做一个招募俘虏的 mod\"."),
			"intent": enumPropDefault([]string{"auto", "make_mod", "api", "docs", "source"}, "auto",
				"Routing hint; leave auto."),
			"limit": propWithDefault("number", 5, "Max results per source."),
		},
		"required": []string{"query"},
	}
	register(server, "search_bannerlord_knowledge", "Search Bannerlord Knowledge",
		"Natural-language entry point: searches official tutorials, community docs, API symbols and decompiled source together. When the API version does not match the installed game, official API hits are reference-only and decompiled source wins. Use for \"调用 mcp 查一下\"/\"我要做一个 mod\"/\"怎么写补丁\"/\"帮我查这个类\".",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_bannerlord_knowledge"))))
}

func registerSearchDocs(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query": prop("string", "Keywords, e.g. Gauntlet UI or SubModule."),
			"source": enumPropDefault([]string{"own", "all", "official", "community"}, "own",
				"Docs source filter; own = our curated knowledge base."),
			"limit": propWithDefault("number", 8, "Max matches."),
		},
		"required": []string{"query"},
	}
	register(server, "search_bannerlord_docs", "Search Bannerlord Docs",
		"Search the knowledge base. Default source is the in-repo own knowledge base (our curated modding know-how + MCP suite docs); official/community web docs are optional add-ons and may be absent unless imported. Best for concepts, workflows, Gauntlet UI, module structure.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_bannerlord_docs"))))
}

func registerSearchAPIDocs(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"query":   prop("string", "Symbol or keyword, e.g. Hero or MBObjectManager."),
			"version": prop("string", "API version, e.g. 1.3.14. Defaults to installed game version."),
			"section": enumProp([]string{"classes", "functions", "properties", "events", "enums", "enumvalues", "variables"},
				"Doxygen section filter."),
			"limit": propWithDefault("number", 10, "Max matches."),
		},
		"required": []string{"query"},
	}
	register(server, "search_bannerlord_api_docs", "Search Bannerlord Official API Docs",
		"Search official Bannerlord API Doxygen symbols. Reports version match; prefer decompiled source when versions differ.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("search_bannerlord_api_docs"))))
}

func registerGetEntity(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"kind": enumProp([]string{"clan", "culture", "hero", "item", "kingdom", "perk", "policy", "settlement", "skill", "troop"},
				"Entity kind to look up."),
			"id": prop("string", "Exact id, e.g. clan_empire_north_3, saddle_horse, lord_1_1, vlandian_recruit, town_B1."),
		},
		"required": []string{"kind", "id"},
	}
	register(server, "get_entity", "Get Gameplay Entity",
		"Look up one Bannerlord gameplay entity by id from the precomputed projection tables. Prefer over reading raw XML. kind: clan, culture, hero, item, kingdom, perk, policy, settlement, skill, troop.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("get_entity"))))
}

func registerGenerateHarmonyPatch(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"className":  prop("string", "Class name, e.g. MobileParty."),
			"methodName": prop("string", "Method name, e.g. CalculateSpeed."),
		},
		"required": []string{"className", "methodName"},
	}
	register(server, "generate_harmony_patch", "Generate Harmony Patch",
		"Generate a Harmony patch scaffold for a known target method. Uses the AST method index, so overload/static details are correct.",
		nil, schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("generate_harmony_patch"))))
}

func registerGenerateXsltPatch(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"targetXPath": prop("string", "XPath to target node, e.g. /Items/Item[@id='saddle_horse']."),
			"operation":   enumProp([]string{"insert", "replace", "delete"}, "insert appends inside target; replace swaps target; delete removes it."),
			"fragment":    prop("string", "XML fragment to insert or replace with. Omit for delete."),
		},
		"required": []string{"targetXPath", "operation"},
	}
	// Registered from registerAuthoringTools (full mode only); nothing to do here.
	_ = schema
}

func registerResolveLocalization(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text": prop("string", "Token like {=P1rL28RT}Sumpter Horse."),
			"languages": map[string]any{
				"type":        "array",
				"items":       map[string]any{"type": "string"},
				"description": "Preferred language order, e.g. [\"English\", \"CN\"].",
			},
		},
		"required": []string{"text"},
	}
	register(server, "resolve_localization", "Resolve Localization Token",
		"Resolve a {=token}Fallback string to its localized text (Languages XML + source fallback literals).",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("resolve_localization"))))
}

// registerIndexAssets and registerFindAsset put the asset-side tools on the stub surface, so
// the tool list is identical to the TypeScript's. Their real bodies bind afterwards in
// registerAll; registering the name here first is what keeps "every tool present exactly
// once" true when a body is missing.
func registerIndexAssets(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"gameDir":  prop("string", "Bannerlord install directory, not the imported assets tree."),
			"moduleId": prop("string", "Restrict to one module under Modules/."),
			"query":    prop("string", "Substring filter over filename, path and module id."),
			"limit":    prop("integer", "Stop after this many entries; the report says when it did."),
		},
		"required": []string{"gameDir"},
	}
	register(server, "index_assets", "Index Assets",
		"List every texture, model and .tpac asset package in a Bannerlord install (or one module). Reports what exists and where; payloads are not decoded.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("index_assets"))))
}

func registerFindAsset(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"gameDir": prop("string", "Bannerlord install directory."),
			"query":   prop("string", "Filename, path fragment or module id. Required."),
		},
		"required": []string{"gameDir", "query"},
	}
	register(server, "find_asset", "Find Asset",
		"Locate one artwork file by name, path fragment or module id. Ranks an exact filename match first.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("find_asset"))))
}

func registerReadGauntletUI(server *mcp.Server, deps *Deps) {
	schema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"uiFileName": prop("string", "UI XML stem, e.g. InventoryScreen."),
		},
		"required": []string{"uiFileName"},
	}
	register(server, "read_gauntlet_ui", "Read Gauntlet UI",
		"Get a ViewModel binding checklist for a Gauntlet UI XML: DataSource fields and click handlers.",
		readOnly(), schema, stubHandler(notImplemented(toolnaming.ArchiveToolName("read_gauntlet_ui"))))
}

// registerAuthoringTools holds the FULL-MODE-ONLY registrations from src/server.ts
// (create_mod_workspace, generate_xslt_patch) plus the five full-mode editor tools.
func registerAuthoringTools(server *mcp.Server, deps *Deps) {
	createSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"workspaceRoot": prop("string", "Parent dir receiving the <moduleId> folder. Refuses non-empty target."),
			"moduleId": map[string]any{
				"type": "string", "pattern": "^[A-Za-z0-9_.]+$",
				"description": "Module id + folder name, e.g. MercenaryGuild.",
			},
			"moduleName":              prop("string", "Display name in SubModule.xml and README."),
			"namespace":               prop("string", "Root C# namespace. Defaults to sanitized moduleId."),
			"authors":                 prop("string", "Author string for .csproj and README."),
			"version":                 prop("string", "Version, 1.0.0 or v1.0.0."),
			"url":                     prop("string", "Metadata URL for SubModule.xml."),
			"updateInfo":              prop("string", "Update descriptor, e.g. NexusMods:1234."),
			"gameDir":                 prop("string", "Install path. Defaults to saved setup state."),
			"includeCampaignBehavior": propWithDefault("boolean", true, "Generate CampaignBehavior scaffold."),
			"includeHarmonyExample":   propWithDefault("boolean", false, "Generate a no-op Harmony postfix example."),
			"includeButterLib":        propWithDefault("boolean", false, "Declare ButterLib dependency."),
			"includeUiExtenderEx":     propWithDefault("boolean", false, "Declare UIExtenderEx dependency."),
			"includeMcm":              propWithDefault("boolean", false, "Declare MBOptionScreen dependency."),
		},
		"required": []string{"workspaceRoot", "moduleId"},
	}
	register(server, "create_mod_workspace", "Create Mod Workspace",
		"Scaffold a local Bannerlord mod workspace: SubModule.xml, English localization, a compilable C# project wired to the local game install, optional CampaignBehavior/Harmony samples.",
		writable(), createSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("create_mod_workspace"))))

	xsltSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"targetXPath": prop("string", "XPath to target node, e.g. /Items/Item[@id='saddle_horse']."),
			"operation":   enumProp([]string{"insert", "replace", "delete"}, "insert appends inside target; replace swaps target; delete removes it."),
			"fragment":    prop("string", "XML fragment to insert or replace with. Omit for delete."),
		},
		"required": []string{"targetXPath", "operation"},
	}
	register(server, "generate_xslt_patch", "Generate XSLT Patch",
		"Generate an XSLT patch for Bannerlord XML instead of editing source XML directly.",
		nil, xsltSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("generate_xslt_patch"))))

	registerAuthoringEditorTools(server)
}

// callToolJSON unmarshals tool arguments into a typed value. Exported for tests that
// drive handlers directly.
func callToolJSON[In any](_ context.Context, req *mcp.CallToolRequest, in *In) error {
	if len(req.Params.Arguments) == 0 {
		return nil
	}
	return json.Unmarshal(req.Params.Arguments, in)
}

var _ = fmt.Sprintf
