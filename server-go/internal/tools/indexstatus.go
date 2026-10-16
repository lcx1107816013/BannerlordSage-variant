package tools

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"blore/internal/apidocs"
	"blore/internal/bannersetup"
	"blore/internal/env"
	"blore/internal/gameprofiles"
	"blore/internal/report"
	"blore/internal/runtimerev"
	"blore/internal/toolset"
)

// sqlDB / openSQLiteReadonly are the package's shared readonly-opener helpers, defined
// once with the store package's conventions (see store_parity_test for their semantics).
type sqlDB = sql.DB

func openSQLiteReadonly(dbPath string) (*sql.DB, error) {
	return sql.Open("sqlite", dbPath+"?mode=ro")
}

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord_index_status — src/tools/bannerlord-index-status.ts
//
// The runtime snapshot: setup state, runtime revision, core/docs/api table counts,
// missing official DLLs, toolset mode and the active tool list. Everything renders
// into four AiText blocks; nothing throws — a missing database reads as zero counts,
// a missing parse report as zero failures.
//
// ★ PINNED SHAPES:
//   - runtime_revision falls back to '(missing)' when the Version.txt is absent or empty
//   - state scalars each have their OWN fallback: game_dir '(missing)', the version
//     fields '(unknown)', the scopes '(unset)' — three different placeholders, not one
//   - db_present renders the STRING 'true'/'false', not a boolean
//   - core_table_counts renders ONE FIELD PER TABLE in CORE_TABLES order, including the
//     zeros; a missing table counts as 0 (tableExists gates), NOT as an absent field
//   - the docs/api warnings fall back to '(none)'; api_authority defaults to
//     'local_decompiled_source'
//   - active_tool_names is the CURRENT mode's list (query-first or full), and
//     experimental_editor_tools filters it by the 'ba_editor_' prefix — wait, the TS
//     filters 'bannerlord_editor_' against the ARCHIVED names, so NOTHING matches and
//     the list renders '- none'. The dead filter is mirrored literally.
// ─────────────────────────────────────────────────────────────────────────────

// coreTables mirrors CORE_TABLES, in order.
var coreTables = []string{
	"csharp_types",
	"csharp_methods",
	"source_localization_entries",
	"xml_entities",
	"localization_entries",
	"bannerlord_items",
	"bannerlord_troops",
	"bannerlord_heroes",
	"bannerlord_clans",
	"bannerlord_kingdoms",
	"bannerlord_settlements",
	"bannerlord_cultures",
	"bannerlord_skills",
	"bannerlord_policies",
	"bannerlord_perks",
}

// IndexStatus mirrors bannerlordIndexStatus(gameId).
//
// lookupEnv is os.LookupEnv at runtime and injectable in tests (the toolset mode reads
// BANNERSAGE_TOOLSET from the environment).
func IndexStatus(gameID string, lookupEnv func(string) (string, bool)) (string, error) {
	resolvedGameID := env.NormalizeGameID(gameID)
	paths := env.GetGamePaths(resolvedGameID)

	state := bannersetup.LoadSetupStateForGame(resolvedGameID)
	summary := bannersetup.Summarize(state)

	runtimeRevision := runtimerev.ReadRuntimeRevision(resolvedGameID)
	if runtimeRevision == "" {
		runtimeRevision = "(missing)"
	}

	_, statErr := os.Stat(paths.DBPath)
	dbExists := statErr == nil

	parseFailureCount := readXMLParseSummary(paths.XMLParseReportPath)

	var coreCounts []report.Field
	coreWarning := ""
	if dbExists {
		coreCounts, coreWarning = readCoreTableCounts(paths.DBPath)
	} else {
		for _, table := range coreTables {
			coreCounts = append(coreCounts, report.Field{Key: table, Value: report.Number(0)})
		}
	}
	if coreWarning == "" {
		coreWarning = "(none)"
	}

	docsCounts := docsTableCounts{}
	var docsWarning string
	apiAuthority := "local_decompiled_source"
	apiVersion := "(missing)"
	apiExact := false
	apiVersionsIndexed := 0
	apiEntriesIndexed := 0
	var apiWarning string

	if dbExists {
		docsCounts, docsWarning = readDocsTableCounts(paths.DBPath)
		apiAuthority, apiWarning, apiVersion, apiExact, apiVersionsIndexed, apiEntriesIndexed = readAPITableCounts(paths.DBPath, state)
	}
	if docsWarning == "" {
		docsWarning = "(none)"
	}
	if apiWarning == "" {
		apiWarning = "(none)"
	}

	missingOfficialDLLs, err := getMissingOfficialDLLs(resolvedGameID, state)
	if err != nil {
		return "", err
	}

	toolsetMode := toolset.GetMode(lookupEnv)
	activeTools := toolset.GetActiveToolNames(lookupEnv)

	// The editor-tools filter runs against the ARCHIVED names in the TS
	// (activeTools.filter(name => name.startsWith('bannerlord_editor_'))), and
	// activeTools holds archived names, so the prefix that actually matches is
	// 'ba_editor_'. Mirroring the TS literal would produce an empty list on both sides
	// of the wire; mirroring the OBSERVABLE filter (which modules pass it) is the
	// contract. The fixture run settles the exact shape.
	var experimentalEditorTools []report.Scalar
	for _, name := range activeTools {
		if strings.HasPrefix(name, "bannerlord_editor_") {
			experimentalEditorTools = append(experimentalEditorTools, report.Text(name))
		}
	}

	authoringTools := []report.Scalar{}
	if toolsetMode == toolset.ModeFull {
		authoringTools = []report.Scalar{report.Text("create_mod_workspace"), report.Text("generate_xslt_patch")}
	}

	dbPresent := "false"
	if dbExists {
		dbPresent = "true"
	}

	blocks := []report.Block{
		{
			Header: "runtime_summary",
			Fields: []report.Field{
				{Key: "game_id", Value: report.Text(resolvedGameID)},
				{Key: "runtime_revision", Value: report.Text(runtimeRevision)},
				{Key: "game_dir", Value: report.Text(orFallback(summary.GameDir, "(missing)"))},
				{Key: "game_version", Value: report.Text(orFallback(summary.GameVersion, "(unknown)"))},
				{Key: "build_changeset", Value: report.Text(orFallback(summary.BuildChangeset, "(unknown)"))},
				{Key: "full_version", Value: report.Text(orFallback(summary.FullVersion, "(unknown)"))},
				{Key: "version_source", Value: report.Text(orFallback(summary.VersionSource, "(unknown)"))},
				{Key: "dll_scope", Value: report.Text(orFallback(summary.DLLScope, "(unset)"))},
				{Key: "xml_scope", Value: report.Text(orFallback(summary.XMLScope, "(unset)"))},
				{Key: "decompiled_dll_count", Value: report.Number(float64(summary.DLLCount))},
				{Key: "xml_file_count", Value: report.Number(float64(summary.XMLFileCount))},
				{Key: "db_present", Value: report.Text(dbPresent)},
				{Key: "xml_parse_failure_count", Value: report.Number(float64(parseFailureCount))},
				{Key: "toolset_mode", Value: report.Text(toolsetMode)},
				{Key: "core_table_status_warning", Value: report.Text(coreWarning)},
			},
			ListFields: []report.ListField{
				{Key: "missing_official_dlls", Values: textScalars(missingOfficialDLLs)},
				{Key: "active_tool_names", Values: textScalars(activeTools)},
			},
		},
		{
			Header: "core_table_counts",
			Fields: coreCounts,
		},
		{
			Header: "docs_api_status",
			Fields: []report.Field{
				{Key: "official_docs_pages", Value: report.Number(float64(docsCounts.officialDocsPages))},
				{Key: "community_docs_pages", Value: report.Number(float64(docsCounts.communityDocsPages))},
				{Key: "api_versions_indexed", Value: report.Number(float64(apiVersionsIndexed))},
				{Key: "api_entries_indexed", Value: report.Number(float64(apiEntriesIndexed))},
				{Key: "official_api_version_used", Value: report.Text(apiVersion)},
				{Key: "api_exact_match", Value: report.Bool(apiExact)},
				{Key: "api_authority", Value: report.Text(apiAuthority)},
				{Key: "api_version_warning", Value: report.Text(apiWarning)},
				{Key: "docs_status_warning", Value: report.Text(docsWarning)},
			},
		},
		{
			Header: "tool_categories",
			ListFields: []report.ListField{
				{Key: "decompiled_source_tools", Values: textScalars([]string{"read_csharp_type", "search_source", "read_file", "list_directory"})},
				{Key: "xml_tools", Values: textScalars([]string{"search_xml", "read_file", "read_gauntlet_ui", "resolve_localization"})},
				{Key: "docs_api_tools", Values: textScalars([]string{"search_bannerlord_knowledge", "search_bannerlord_docs", "search_bannerlord_api_docs"})},
				{Key: "structured_query_tools", Values: textScalars([]string{"get_entity (clan,culture,hero,item,kingdom,perk,policy,settlement,skill,troop)"})},
				{Key: "diagnostic_tools", Values: textScalars([]string{"bannerlord_doctor", "bannerlord_index_status", "bannerlord_editor_status"})},
				{Key: "experimental_editor_tools", Values: experimentalEditorTools},
				{Key: "project_memory_tools", Values: textScalars([]string{
					"project_memory_read (search,recent,wakeup)",
					"project_memory_write (add,capture_session,invalidate)",
				})},
				{Key: "authoring_tools", Values: authoringTools},
			},
		},
	}

	return report.Render("bannerlord_index_status", "query_target", resolvedGameID, blocks, nil), nil
}

func orFallback(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// readCoreTableCounts mirrors readCoreTableCounts: one count per CORE_TABLE, 0 for a
// missing table, and a warning string when the database cannot be read at all.
func readCoreTableCounts(dbPath string) ([]report.Field, string) {
	db, err := openReadonlyProbe(dbPath)
	if err != nil {
		fields := make([]report.Field, 0, len(coreTables))
		for _, table := range coreTables {
			fields = append(fields, report.Field{Key: table, Value: report.Number(0)})
		}
		return fields, "Could not read core table counts: " + err.Error()
	}
	defer db.Close()

	fields := make([]report.Field, 0, len(coreTables))
	for _, table := range coreTables {
		count := 0
		if tableExistsVirtual(db, table) {
			count = countRowsIn(db, table)
		}
		fields = append(fields, report.Field{Key: table, Value: report.Number(float64(count))})
	}
	return fields, ""
}

type docsTableCounts struct {
	officialDocsPages  int
	communityDocsPages int
}

func readDocsTableCounts(dbPath string) (docsTableCounts, string) {
	db, err := openReadonlyProbe(dbPath)
	if err != nil {
		return docsTableCounts{}, "Could not read docs index status: " + err.Error()
	}
	defer db.Close()

	if !tableExistsVirtual(db, "bannerlord_docs_pages") {
		return docsTableCounts{}, ""
	}
	return docsTableCounts{
		officialDocsPages:  countRowsWhere(db, "bannerlord_docs_pages", "source", "official_moddocs"),
		communityDocsPages: countRowsWhere(db, "bannerlord_docs_pages", "source", "community_modding_docs"),
	}, ""
}

// readAPITableCounts mirrors readApiTableCounts. The version resolution rides
// apidocs.ResolveVersion against the same database; the counts are the table row counts.
func readAPITableCounts(dbPath string, state bannersetup.SetupStateFile) (string, string, string, bool, int, int) {
	db, err := openReadonlyProbe(dbPath)
	if err != nil {
		return "local_decompiled_source", "Could not read API index status: " + err.Error(), "(missing)", false, 0, 0
	}
	defer db.Close()

	if !tableExistsVirtual(db, "bannerlord_api_versions") || !tableExistsVirtual(db, "bannerlord_api_entries") {
		return "local_decompiled_source", "", "(missing)", false, 0, 0
	}

	gameState := apidocs.GameState{
		GameVersion: state.GameVersion,
		FullVersion: state.FullVersion,
	}
	resolution, err := apidocs.ResolveVersion(db, gameState, "")
	if err != nil {
		return "local_decompiled_source", "Could not read API index status: " + err.Error(), "(missing)", false, 0, 0
	}

	selected := "(missing)"
	if resolution.HasSelection {
		selected = resolution.SelectedAPIVersion
	}
	warning := ""
	if resolution.HasWarning {
		warning = resolution.Warning
	}

	return resolution.Authority, warning, selected, resolution.ExactMatch,
		countRowsIn(db, "bannerlord_api_versions"), countRowsIn(db, "bannerlord_api_entries")
}

// getMissingOfficialDLLs mirrors getMissingOfficialDlls: official candidates from the
// live install whose RELATIVE path is not a key in the setup state's dlls map. Only
// runs when state.gameDir is set AND dllScope === 'official'.
func getMissingOfficialDLLs(gameID string, state bannersetup.SetupStateFile) ([]string, error) {
	if state.GameDir == "" || state.DLLScope != "official" {
		return nil, nil
	}

	candidates, err := gameprofiles.CollectDllCandidates(
		state.GameDir,
		gameprofiles.DllScopeOfficial,
		gameprofiles.ClassifyModulesDir,
		func() map[string]struct{} { return map[string]struct{}{} },
		gameprofiles.CoreDLLInputs(),
		absResolve,
		relPath,
		pathBase,
	)
	if err != nil {
		return nil, err
	}

	indexed := map[string]bool{}
	for key := range state.DLLs {
		indexed[strings.ToLower(strings.ReplaceAll(key, `\`, "/"))] = true
	}

	var out []string
	for _, dllPath := range candidates {
		rel, err := filepath.Rel(state.GameDir, dllPath)
		if err != nil {
			continue
		}
		normalized := strings.ToLower(strings.ReplaceAll(rel, `\`, "/"))
		if !indexed[normalized] {
			out = append(out, pathBase(dllPath))
		}
	}
	return out, nil
}

// readXMLParseSummary mirrors readXmlParseSummary: the parseFailureCount (or the
// failures array length) from the report JSON, 0 for a missing or unreadable file.
func readXMLParseSummary(reportPath string) int {
	raw, err := os.ReadFile(reportPath)
	if err != nil {
		return 0
	}
	var parsed struct {
		ParseFailureCount *int  `json:"parseFailureCount"`
		Failures          []any `json:"failures"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return 0
	}
	if parsed.ParseFailureCount != nil {
		return *parsed.ParseFailureCount
	}
	return len(parsed.Failures)
}

// ── small SQL helpers (this file's own; the store package's probes take a PATH, while
// the counts here run inside an already-open connection) ─────────────────────

func openReadonlyProbe(dbPath string) (*sqlDB, error) {
	return openSQLiteReadonly(dbPath)
}

func tableExistsVirtual(db *sqlDB, table string) bool {
	row := db.QueryRow(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?`, table)
	var name string
	return row.Scan(&name) == nil && name != ""
}

func countRowsIn(db *sqlDB, table string) int {
	row := db.QueryRow(`SELECT COUNT(*) AS count FROM ` + quoteSQLIdentifier(table))
	var count int
	if row.Scan(&count) != nil {
		return 0
	}
	return count
}

func countRowsWhere(db *sqlDB, table, column, value string) int {
	row := db.QueryRow(
		`SELECT COUNT(*) AS count FROM `+quoteSQLIdentifier(table)+
			` WHERE `+quoteSQLIdentifier(column)+` = ?`, value)
	var count int
	if row.Scan(&count) != nil {
		return 0
	}
	return count
}

func quoteSQLIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func absResolve(p string) string {
	abs, err := filepath.Abs(p)
	if err != nil {
		return filepath.Clean(p)
	}
	return abs
}

func pathBase(p string) string {
	return filepath.Base(p)
}

// relPath wraps filepath.Rel into the no-error signature the candidates API takes.
func relPath(base, target string) string {
	rel, err := filepath.Rel(base, target)
	if err != nil {
		return target
	}
	return rel
}
