package tools

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"

	"blore/internal/mods"
	"blore/internal/report"
)

// joinPath / relativeTo / toForwardSlash are local path helpers mirroring node's
// path.join / path.relative semantics for the relative paths csharp_files stores
// (forward slashes, relative to the source root).
func joinPath(base, rel string) string {
	return filepath.Join(base, filepath.FromSlash(rel))
}

func relativeTo(base, fullPath string) (string, error) {
	rel, err := filepath.Rel(base, fullPath)
	if err != nil {
		return "", err
	}
	return toForwardSlash(rel), nil
}

func toForwardSlash(p string) string {
	return strings.ReplaceAll(p, "\\", "/")
}

// ─────────────────────────────────────────────────────────────────────────────
// The local mod C# index facade — src/utils/local-mod-csharp-index.ts
//
// TWO ENTRY POINTS, both delegating to pieces that already exist:
//
//   getLocalModSourceStatus -> resolve workspace, count .cs files, render the summary
//   readLocalModType        -> resolve workspace, count .cs files, read one indexed type
//                              through ReadCsharpType with the local-mod vocabulary
//
// ★ WHAT IS DELIBERATELY NOT HERE: buildModSourceIndex. The TS indexer shells out to the
// bundled Roslyn project (tools/BannerlordSage.CSharpIndexer) and folds its JSON into
// SQLite; that is a .NET build pipeline, not a port surface, and the Go tools assume the
// index exists exactly as the TS tools do today (index_mod_source stays a stub in the
// registry until that changes). Both functions below therefore RENDER FROM THE EXISTING
// DATABASE and never create or refresh it.
//
// ★ THE REPORTS DESCRIBE THE LAST INDEXING RUN, not a static state: changed/removed
// counts are properties of the last build the workspace saw. The differential harness
// runs the TS with an injected indexer whose summary carries changed=0/removed=0 — the
// values a fresh index produces — and this port renders the same two numbers from the
// revision-file signal below. See collectModSourceSummary for how they derive.
// ─────────────────────────────────────────────────────────────────────────────

// ModSourceStatus mirrors getLocalModSourceStatus(workspaceRoot): the rendered
// local_mod_source_status report.
func ModSourceStatus(workspaceRoot string) (string, error) {
	summary, err := collectModSourceSummary(workspaceRoot)
	if err != nil {
		return "", err
	}

	return report.Render("local_mod_source_status", "workspace_root", summary.WorkspaceRoot, []report.Block{{
		Header: "workspace_summary",
		Fields: []report.Field{
			{Key: "workspace_root", Value: report.Text(summary.WorkspaceRoot)},
			{Key: "source_root", Value: report.Text(summary.SourceRoot)},
			{Key: "cache_root", Value: report.Text(summary.CacheRoot)},
			{Key: "csharp_file_count", Value: report.Number(float64(summary.CSharpFileCount))},
			{Key: "changed_files_reindexed", Value: report.Number(float64(summary.ChangedFiles))},
			{Key: "removed_files_detected", Value: report.Number(float64(summary.RemovedFiles))},
			{Key: "indexed_type_count", Value: report.Number(float64(summary.TypeCount))},
			{Key: "indexed_member_count", Value: report.Number(float64(summary.MemberCount))},
			{Key: "indexed_source_localization_count", Value: report.Number(float64(summary.SourceLocalizationCount))},
		},
	}}, nil), nil
}

// ReadModType mirrors readLocalModType(workspaceRoot, typeName): one indexed type (or
// the multi-match disambiguation report) with the local-mod vocabulary — its own
// reportType, notFoundText and the four topFields, which is the reason
// CsharpTypeOptions exists (see the struct's comment).
func ReadModType(workspaceRoot, typeName string) (string, error) {
	summary, err := collectModSourceSummary(workspaceRoot)
	if err != nil {
		return "", err
	}

	db, err := sql.Open("sqlite", summary.DBPath+"?mode=ro")
	if err != nil {
		return "", err
	}
	defer db.Close()

	return ReadCsharpType(db, summary.SourceRoot, typeName, CsharpTypeOptions{
		QueryLabel: "query_type_name",
		ReportType: "local_mod_type_read",
		NotFoundText: fmt.Sprintf(
			"Type '%s' was not found in the indexed mod source workspace (%s).",
			typeName, summary.SourceRoot),
		TopFields: []report.Field{
			{Key: "workspace_root", Value: report.Text(summary.WorkspaceRoot)},
			{Key: "source_root", Value: report.Text(summary.SourceRoot)},
			{Key: "changed_files_reindexed", Value: report.Number(float64(summary.ChangedFiles))},
			{Key: "removed_files_detected", Value: report.Number(float64(summary.RemovedFiles))},
		},
	})
}

// SearchModSource mirrors searchModSource(workspaceRoot, query, caseSensitive,
// filePattern) from src/tools/search-mod-source.ts: resolve the source dir, delegate to
// SearchSource UNCHANGED. The whole body is the same three lines as the TypeScript — no
// extra validation, no error rewriting.
func SearchModSource(ctx context.Context, workspaceRoot, query string, caseSensitive bool, filePattern string) (string, error) {
	sourceDir, err := mods.EnsureModSourceDir(workspaceRoot)
	if err != nil {
		return "", err
	}
	return SearchSource(ctx, sourceDir, query, caseSensitive, filePattern)
}

// modSourceSummary is the subset of ModSourceIndexSummary the two read paths produce
// without running the Roslyn indexer.
type modSourceSummary struct {
	WorkspaceRoot  string
	SourceRoot     string
	CacheRoot      string
	DBPath         string
	CSharpFileCount int

	// The last-build counts. The TS gets them from buildModSourceIndex's return value;
	// this port derives them from the WORKSPACE DATABASE the same way the indexer's
	// incremental logic does: the files recorded in csharp_files versus the .cs files on
	// disk now. A file on disk but not in the table is a pending CHANGE; a table row
	// whose file is gone is a pending REMOVAL. A workspace whose database matches its
	// files reads 0/0 — the same numbers the injected indexer reported in the fixture
	// run, which is what makes the differential meaningful.
	ChangedFiles             int
	RemovedFiles             int
	TypeCount                int
	MemberCount              int
	SourceLocalizationCount  int
}

// collectModSourceSummary resolves the workspace (creating the cache dir, as the TS
// does) and reads the derivable counts.
func collectModSourceSummary(workspaceRoot string) (modSourceSummary, error) {
	workspace, err := mods.ResolveModSourceWorkspace(workspaceRoot)
	if err != nil {
		return modSourceSummary{}, err
	}

	count, err := mods.CountModSourceCSharpFiles(workspace.SourceRoot)
	if err != nil {
		return modSourceSummary{}, err
	}

	out := modSourceSummary{
		WorkspaceRoot:   workspace.WorkspaceRoot,
		SourceRoot:      workspace.SourceRoot,
		CacheRoot:       workspace.CacheRoot,
		DBPath:          workspace.DBPath,
		CSharpFileCount: count,
	}

	db, err := sql.Open("sqlite", workspace.DBPath+"?mode=ro")
	if err != nil {
		// No database yet: every .cs file is a pending change, nothing is removed, all
		// counts are zero. The TS would have BUILT the index first; this port only
		// reads, so the honest summary of an unbuilt workspace is "all files pending".
		out.ChangedFiles = count
		return out, nil
	}
	defer db.Close()

	out.TypeCount = countRowsOrZero(db, "csharp_types")
	out.MemberCount = countRowsOrZero(db, "csharp_methods")
	out.SourceLocalizationCount = countRowsOrZero(db, "source_localization_entries")

	// Indexed rows whose files no longer exist -> pending removals.
	out.RemovedFiles = countMissingIndexedFiles(db, workspace.SourceRoot)

	// On-disk .cs files not present in csharp_files -> pending changes.
	indexed := indexedFileSet(db)
	if err := mods.WalkModSourceCSharpFiles(workspace.SourceRoot, func(fullPath string) error {
		rel, err := relativeTo(workspace.SourceRoot, fullPath)
		if err != nil {
			return err
		}
		if !indexed[rel] {
			out.ChangedFiles++
		}
		return nil
	}); err != nil {
		return modSourceSummary{}, err
	}

	return out, nil
}

func countRowsOrZero(db *sql.DB, table string) int {
	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM " + table).Scan(&count); err != nil {
		return 0
	}
	return count
}

// countMissingIndexedFiles counts csharp_files rows whose file is absent on disk.
func countMissingIndexedFiles(db *sql.DB, sourceRoot string) int {
	rows, err := db.Query(`SELECT filePath FROM csharp_files`)
	if err != nil {
		return 0
	}
	defer rows.Close()

	missing := 0
	for rows.Next() {
		var rel string
		if err := rows.Scan(&rel); err != nil {
			continue
		}
		if !fileExists(joinPath(sourceRoot, rel)) {
			missing++
		}
	}
	return missing
}

// indexedFileSet reads csharp_files into a set of relative (forward-slashed) paths.
func indexedFileSet(db *sql.DB) map[string]bool {
	out := map[string]bool{}
	rows, err := db.Query(`SELECT filePath FROM csharp_files`)
	if err != nil {
		return out
	}
	defer rows.Close()
	for rows.Next() {
		var rel string
		if err := rows.Scan(&rel); err != nil {
			continue
		}
		out[toForwardSlash(rel)] = true
	}
	return out
}
