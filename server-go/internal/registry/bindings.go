package registry

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/apidocs"
	"blore/internal/bannersetup"
	"blore/internal/env"
	"blore/internal/gameplay"
	"blore/internal/sandbox"
	"blore/internal/toolnaming"
	"blore/internal/tools"
)

// ─────────────────────────────────────────────────────────────────────────────
// Handler bindings: the ported tool bodies wired to their registrations.
//
// Every handler follows the same shape: unmarshal the arguments, resolve the
// dependencies (db handle, sandbox, setup state), call the ported body, wrap the
// rendered text in one TextContent block. Errors return as tool errors (the SDK packs
// them into CallToolResult with IsError), which mirrors the TS tools' thrown errors
// surfacing as error results.
//
// ★ DB OPENING IS LAZY PER CALL, not at startup. getDb() in the TS opens on first use
// and drops the handle when the runtime revision changes; the Go store keeps the same
// cached-handle semantics. Opening at startup would freeze the connection before the
// readiness gate has even run.
// ─────────────────────────────────────────────────────────────────────────────

// args unmarshals req.Params.Arguments into a typed value; empty arguments unmarshal
// to the zero value, matching the TS tools' defaulted destructuring.
func args[In any](req *mcp.CallToolRequest) (In, error) {
	var in In
	if len(req.Params.Arguments) == 0 {
		return in, nil
	}
	if err := json.Unmarshal(req.Params.Arguments, &in); err != nil {
		return in, err
	}
	return in, nil
}

// gameDB opens (or returns the cached) game index database.
func (d *Deps) gameDB() (*sql.DB, error) {
	if d.OpenGameDB == nil {
		return nil, errNoDB
	}
	return d.OpenGameDB()
}

// assetsSandbox builds the PathSandbox over the active game's assets root — the same
// `new PathSandbox(assetsPath)` src/server.ts constructs once at module scope. It is
// rebuilt per call because the active game can differ per process only; the sandbox
// itself is stateless.
func assetsSandbox() *sandbox.Sandbox {
	return sandbox.New("", env.GetGamePaths(env.ActiveGameID()).AssetsPath)
}

// gameState reads the setup state's version fields for SearchAPIDocs' resolution.
func gameState() apidocs.GameState {
	state := bannersetup.LoadSetupStateForGame(env.ActiveGameID())
	return apidocs.GameState{
		GameVersion: state.GameVersion,
		FullVersion: state.FullVersion,
	}
}

// ── query tools over the game index ─────────────────────────────────────────

func bindReadFile(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("read_file"),
		Title:       "Read Indexed File Slice",
		Description: "Read a slice of an indexed source or XML file. Read only the relevant region to save context.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": prop("string", "Path relative to dist/games/"+env.ActiveGameID()+"/assets, e.g. Xmls/Modules/Native/ModuleData/crafting_pieces.xml."),
				"startLine": propWithDefault("number", 0,
					"Zero-based start line."),
				"lineCount": propWithDefault("number", 400, "Max lines."),
			},
			"required": []string{"path"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Path      string `json:"path"`
			StartLine int    `json:"startLine"`
			LineCount int    `json:"lineCount"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ReadFile(assetsSandbox(), in.Path, in.StartLine, in.LineCount)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindListDirectory(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("list_directory"),
		Title:       "List Indexed Directory",
		Description: "Explore what has been imported into dist/games/" + env.ActiveGameID() + "/assets before opening a file.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"path": propWithDefault("string", "", "Dir relative to assets root; empty lists top level."),
			},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Path string `json:"path"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ListDirectory(assetsSandbox(), in.Path)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindSearchXML(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("search_xml"),
		Title:       "Search XML Data",
		Description: "Full-text lookup across imported XML (ModuleData, Languages). Find which files mention an entity or token.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": prop("string", "1-4 focused keywords."),
			},
			"required": []string{"query"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Query string `json:"query"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.SearchXML(db, in.Query)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindSearchDocs(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("search_bannerlord_docs"),
		Title:       "Search Bannerlord Docs",
		Description: "Search the knowledge base. Default source is the in-repo own knowledge base (our curated modding know-how + MCP suite docs); official/community web docs are optional add-ons and may be absent unless imported. Best for concepts, workflows, Gauntlet UI, module structure.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": prop("string", "Keywords, e.g. Gauntlet UI or SubModule."),
				"source": enumPropDefault([]string{"own", "all", "official", "community"}, "own",
					"Docs source filter; own = our curated knowledge base."),
				"limit": propWithDefault("number", 8, "Max matches."),
			},
			"required": []string{"query"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Query  string `json:"query"`
			Source string `json:"source"`
			Limit  int    `json:"limit"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.SearchDocs(db, in.Query, in.Source, in.Limit)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindSearchAPIDocs(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("search_bannerlord_api_docs"),
		Title:       "Search Bannerlord Official API Docs",
		Description: "Search official Bannerlord API Doxygen symbols. Reports version match; prefer decompiled source when versions differ.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":   prop("string", "Symbol or keyword, e.g. Hero or MBObjectManager."),
				"version": prop("string", "API version, e.g. 1.3.14. Defaults to installed game version."),
				"section": enumProp([]string{"classes", "functions", "properties", "events", "enums", "enumvalues", "variables"},
					"Doxygen section filter."),
				"limit": propWithDefault("number", 10, "Max matches."),
			},
			"required": []string{"query"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Query   string `json:"query"`
			Version string `json:"version"`
			Section string `json:"section"`
			Limit   int    `json:"limit"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.SearchAPIDocs(db, gameState(), in.Query, in.Version, in.Section, in.Limit)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindGetEntity(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("get_entity"),
		Title:       "Get Gameplay Entity",
		Description: "Look up one Bannerlord gameplay entity by id from the precomputed projection tables. Prefer over reading raw XML. kind: clan, culture, hero, item, kingdom, perk, policy, settlement, skill, troop.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"kind": enumProp([]string{"clan", "culture", "hero", "item", "kingdom", "perk", "policy", "settlement", "skill", "troop"},
					"Entity kind to look up."),
				"id": prop("string", "Exact id, e.g. clan_empire_north_3, saddle_horse, lord_1_1, vlandian_recruit, town_B1."),
			},
			"required": []string{"kind", "id"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Kind string `json:"kind"`
			ID   string `json:"id"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := gameplay.GetEntity(db, in.Kind, in.ID, nil)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindResolveLocalization(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("resolve_localization"),
		Title:       "Resolve Localization Token",
		Description: "Resolve a {=token}Fallback string to its localized text (Languages XML + source fallback literals).",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
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
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Text      string   `json:"text"`
			Languages []string `json:"languages"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.ResolveLocalization(db, in.Text, in.Languages)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindReadGauntletUI(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("read_gauntlet_ui"),
		Title:       "Read Gauntlet UI",
		Description: "Get a ViewModel binding checklist for a Gauntlet UI XML: DataSource fields and click handlers.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"uiFileName": prop("string", "UI XML stem, e.g. InventoryScreen."),
			},
			"required": []string{"uiFileName"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			UIFileName string `json:"uiFileName"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ReadGauntletUI(assetsSandbox(), in.UIFileName)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindReadCsharpType(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("read_csharp_type"),
		Title:       "Read C# Type",
		Description: "Get the decompiled definition of a known Bannerlord type. Prefer over text search for classes/structs/enums.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"typeName": prop("string", "Exact type name, e.g. MobileParty or Hero."),
			},
			"required": []string{"typeName"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			TypeName string `json:"typeName"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		// readCsharpType.ts passes getGamePaths().sourcePath — the ACTIVE game's source
		// root, the same path the decompiled tree lives under.
		text, err := tools.ReadCsharpType(db, env.GetGamePaths(env.ActiveGameID()).SourcePath, in.TypeName, tools.CsharpTypeOptions{})
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindSearchSource(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("search_source"),
		Title:       "Search Decompiled Source",
		Description: "ripgrep the decompiled C# source tree. Use when the exact type/method location is unknown.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":       prop("string", "Keyword or regex. Keep narrow, e.g. CalculateSpeed."),
				"filePattern": prop("string", "Glob filter, e.g. *.cs or */CampaignSystem/*.cs."),
			},
			"required": []string{"query"},
		}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Query       string `json:"query"`
			FilePattern string `json:"filePattern"`
		}](req)
		if err != nil {
			return nil, err
		}
		// searchSource(sandbox, query, false, filePattern): the sandbox's base is the
		// root the runner's cwd is set to.
		text, err := tools.SearchSource(ctx, assetsSandbox().BasePath(), in.Query, false, in.FilePattern)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

// ── the four freshly-ported routes ──────────────────────────────────────────

func bindSearchKnowledge(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("search_bannerlord_knowledge"),
		Title:       "Search Bannerlord Knowledge",
		Description: "Natural-language entry point: searches official tutorials, community docs, API symbols and decompiled source together. When the API version does not match the installed game, official API hits are reference-only and decompiled source wins. Use for \"调用 mcp 查一下\"/\"我要做一个 mod\"/\"怎么写补丁\"/\"帮我查这个类\".",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query": prop("string", "Natural-language request, e.g. \"我要做一个招募俘虏的 mod\"."),
				"intent": enumPropDefault([]string{"auto", "make_mod", "api", "docs", "source"}, "auto",
					"Routing hint; leave auto."),
				"limit": propWithDefault("number", 5, "Max results per source."),
			},
			"required": []string{"query"},
		}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			Query  string `json:"query"`
			Intent string `json:"intent"`
			Limit  int    `json:"limit"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.SearchKnowledge(ctx, db, gameState(), assetsSandbox(), in.Query, in.Intent, in.Limit)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindIndexStatus(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("bannerlord_index_status"),
		Title:       "Bannerlord Index Status",
		Description: "Inspect BannerlordSage runtime state: active scopes, indexed table counts, XML parse failures, missing DLL coverage, toolset mode.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{"type": "object", "properties": map[string]any{}}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		// The TS registration calls bannerlordIndexStatus('bannerlord') — the id is
		// HARD-CODED at the registration site, not read from the active game.
		text, err := tools.IndexStatus("bannerlord", envLookup)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindGenerateHarmonyPatch(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("generate_harmony_patch"),
		Title:       "Generate Harmony Patch",
		Description: "Generate a Harmony patch scaffold for a known target method. Uses the AST method index, so overload/static details are correct.",
		// The TS registration carries NO annotations for this tool.
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"className":  prop("string", "Class name, e.g. MobileParty."),
				"methodName": prop("string", "Method name, e.g. CalculateSpeed."),
			},
			"required": []string{"className", "methodName"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			ClassName  string `json:"className"`
			MethodName string `json:"methodName"`
		}](req)
		if err != nil {
			return nil, err
		}
		db, err := depsGameDB()
		if err != nil {
			return nil, err
		}
		text, err := tools.GenerateHarmonyPatch(db, in.ClassName, in.MethodName)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

func bindModSourceTools(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("mod_source_status"),
		Title:       "Local Mod Source Status",
		Description: "Inspect a local mod source workspace: resolved source root and indexed type/member counts.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type":       "object",
			"properties": map[string]any{"workspaceRoot": prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.")},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			WorkspaceRoot string `json:"workspaceRoot"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ModSourceStatus(in.WorkspaceRoot)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})

	server.AddTool(&mcp.Tool{
		Name:        name("search_mod_source"),
		Title:       "Search Local Mod Source",
		Description: "ripgrep over your local mod source tree (not the imported decompile tree). Fastest for frequently edited mod code.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR."),
				"query":         prop("string", "Keyword or regex."),
				"caseSensitive": propWithDefault("boolean", false, "Case-sensitive search."),
				"filePattern":   prop("string", "Glob filter, e.g. *.cs or *Patch*.cs."),
			},
			"required": []string{"query"},
		}),
	}, func(ctx context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			WorkspaceRoot string `json:"workspaceRoot"`
			Query         string `json:"query"`
			CaseSensitive bool   `json:"caseSensitive"`
			FilePattern   string `json:"filePattern"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.SearchModSource(ctx, in.WorkspaceRoot, in.Query, in.CaseSensitive, in.FilePattern)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})

	server.AddTool(&mcp.Tool{
		Name:        name("read_mod_type"),
		Title:       "Read Local Mod Type",
		Description: "Read a class/struct/interface/enum definition from your local mod source (cache refreshes on change).",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR."),
				"typeName":      prop("string", "Exact type name, e.g. SubModule."),
			},
			"required": []string{"typeName"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			WorkspaceRoot string `json:"workspaceRoot"`
			TypeName      string `json:"typeName"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ReadModType(in.WorkspaceRoot, in.TypeName)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

// bindModFileTools wires list_mod_directory and read_mod_file.
func bindModFileTools(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("read_mod_file"),
		Title:       "Read Local Mod File",
		Description: "Read a line slice from your local mod source tree (live files, edits visible immediately).",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR."),
				"path":          prop("string", "Path relative to source root."),
				"startLine":     propWithDefault("number", 0, "Zero-based start line."),
				"lineCount":     propWithDefault("number", 400, "Max lines."),
			},
			"required": []string{"path"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			WorkspaceRoot string `json:"workspaceRoot"`
			Path          string `json:"path"`
			StartLine     int    `json:"startLine"`
			LineCount     int    `json:"lineCount"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ReadModFile(in.WorkspaceRoot, in.Path, in.StartLine, in.LineCount)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})

	server.AddTool(&mcp.Tool{
		Name:        name("list_mod_directory"),
		Title:       "List Local Mod Directory",
		Description: "List files and subdirs under your local mod source workspace.",
		Annotations: readOnly(),
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workspaceRoot": prop("string", "Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR."),
				"path":          propWithDefault("string", "", "Dir relative to source root."),
			},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			WorkspaceRoot string `json:"workspaceRoot"`
			Path          string `json:"path"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.ListModDirectory(in.WorkspaceRoot, in.Path)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

// bindGenerateXsltPatch wires the FULL-MODE-ONLY xslt tool.
func bindGenerateXsltPatch(server *mcp.Server, _ *Deps) {
	server.AddTool(&mcp.Tool{
		Name:        name("generate_xslt_patch"),
		Title:       "Generate XSLT Patch",
		Description: "Generate an XSLT patch for Bannerlord XML instead of editing source XML directly.",
		// The TS registration carries NO annotations for this tool.
		InputSchema: schema(map[string]any{
			"type": "object",
			"properties": map[string]any{
				"targetXPath": prop("string", "XPath to target node, e.g. /Items/Item[@id='saddle_horse']."),
				"operation":   enumProp([]string{"insert", "replace", "delete"}, "insert appends inside target; replace swaps target; delete removes it."),
				"fragment":    prop("string", "XML fragment to insert or replace with. Omit for delete."),
			},
			"required": []string{"targetXPath", "operation"},
		}),
	}, func(_ context.Context, req *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		in, err := args[struct {
			TargetXPath string `json:"targetXPath"`
			Operation   string `json:"operation"`
			Fragment    string `json:"fragment"`
		}](req)
		if err != nil {
			return nil, err
		}
		text, err := tools.GenerateXsltPatch(in.TargetXPath, in.Operation, in.Fragment)
		if err != nil {
			return nil, err
		}
		return textOnly(text), nil
	})
}

// name is the archiveToolName helper at the binding site — the same one the TS
// registration uses, so a binding cannot hand-write a drifted name.
func name(legacy string) string {
	return toolnaming.ArchiveToolName(legacy)
}

// depsGameDB is the package-level accessor the handlers use (a var so tests can stub it).
var depsGameDB = func() (*sql.DB, error) {
	if activeDeps == nil {
		return nil, errNoDB
	}
	return activeDeps.gameDB()
}

var activeDeps *Deps

// errNoDB distinguishes "no opener wired" from a database error.
var errNoDB = errNoDBType{}

type errNoDBType struct{}

func (errNoDBType) Error() string { return "no database opener wired into the registry" }

// envLookup is os.LookupEnv at runtime; a var for tests.
var envLookup = os.LookupEnv
