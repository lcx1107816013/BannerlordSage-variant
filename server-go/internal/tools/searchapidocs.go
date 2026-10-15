package tools

import (
	"database/sql"
	"strings"

	"blore/internal/apidocs"
	"blore/internal/fts"
	"blore/internal/report"
)

// Limits for search_api_docs. See the note on the docs constants: the two tools have DIFFERENT
// defaults and ceilings, and each port keeps its own pair.
const (
	DefaultAPIDocsLimit = 10
	MaxAPIDocsLimit     = 30
)

// ClampAPIDocsLimit mirrors clampLimit (api-docs): default 10, ceiling 30.
//
// The same measured shape as ClampDocsLimit — a negative value is clamped to 1, not defaulted, and
// only an UNUSABLE value takes the default, which a Go int cannot express.
func ClampAPIDocsLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	if limit > MaxAPIDocsLimit {
		return MaxAPIDocsLimit
	}
	return limit
}

// SearchAPIDocs mirrors searchApiDocs from src/tools/search-api-docs.ts.
//
// ★ THE TABLE PREDICATE HERE DIFFERS FROM THE DOCS TOOL'S SPELLING, though not observably: this
// module's private hasTable writes `type IN ('table', 'virtual')` while db.ts's databaseHasTable
// writes `type = 'table'`. Measured on this sqlite, an FTS5 table appears in sqlite_master with
// type = 'table' (verified in a synthetic database and in the real index), so both spellings admit
// the same rows today; each port keeps its own source's wording.
//
// ★ FOUR EARLY RETURNS BEFORE ANY SEARCH, and they are different questions:
//  1. the FTS table is absent      -> a report with index_status "missing" and a setup hint
//  2. the index holds NO versions  -> a report carrying the resolution warning and no matches
//  3. a version WAS requested and is not indexed -> no selection, so the same shape as (2)
//  4. otherwise the search runs, and the resolution's fields are rendered as top fields
//
// Branches (2) and (3) both render with NO blocks, and the only way a caller tells them apart is
// the warning text and available_versions. That is the original's contract.
//
// ★ THE LIKE FALLBACK IS NOT A RETRY OF THE SAME QUESTION. When the FTS query returns nothing the
// tool re-queries the base table with a substring match, ordered exact-title > prefix-title > the
// rest — a path for short tokens and symbols that phrase matching cannot find. A port that treated
// "no rows" as "no results" would drop it silently.
func SearchAPIDocs(db *sql.DB, state apidocs.GameState, query, version string, section string, limit int) (string, error) {
	if !hasTableIncludingVirtual(db, "bannerlord_api_entries_fts") {
		return report.Render("bannerlord_api_search", "query_text", query, nil, []report.Field{
			{Key: "index_status", Value: report.Text("missing")},
			{Key: "setup_hint", Value: report.Text("Run bun run index:api-docs first.")},
			{Key: "installed_game_version", Value: report.Text(placeholder(state.GameVersion, "(unknown)"))},
			{Key: "installed_full_version", Value: report.Text(placeholder(state.FullVersion, "(unknown)"))},
			{Key: "authority", Value: report.Text("local_decompiled_source")},
		}), nil
	}

	resolution, err := apidocs.ResolveVersion(db, state, version)
	if err != nil {
		return "", err
	}

	if !resolution.HasSelection {
		return report.Render("bannerlord_api_search", "query_text", query, nil, []report.Field{
			{Key: "index_status", Value: report.Text("ready")},
			{Key: "installed_game_version", Value: report.Text(placeholder(resolution.InstalledGameVersion, "(unknown)"))},
			{Key: "installed_full_version", Value: report.Text(placeholder(resolution.InstalledFullVersion, "(unknown)"))},
			{Key: "requested_api_version", Value: report.Text(placeholder(resolution.RequestedAPIVersion, "(none)"))},
			{Key: "authority", Value: report.Text(resolution.Authority)},
			{Key: "version_warning", Value: report.Text(placeholder(resolution.Warning, "(none)"))},
			{Key: "available_versions", Value: report.Text(placeholder(strings.Join(resolution.AvailableVersions, ", "), "(none)"))},
		}), nil
	}

	ftsQuery := fts.BuildQuery(query)
	normalizedSection := normalizeAPISection(section)
	clamped := ClampAPIDocsLimit(limit)

	rows, err := db.Query(`
		SELECT
			id,
			version,
			section,
			searchKey,
			title,
			scope,
			url,
			snippet(bannerlord_api_entries_fts, 4, '[', ']', ' ... ', 18) AS titleSnippet,
			snippet(bannerlord_api_entries_fts, 5, '[', ']', ' ... ', 18) AS scopeSnippet
		FROM bannerlord_api_entries_fts
		WHERE bannerlord_api_entries_fts MATCH ?
			AND version = ?
			AND (? IS NULL OR section = ?)
		ORDER BY bm25(bannerlord_api_entries_fts, 0.5, 0.5, 0.5, 4.0, 8.0, 2.0, 0.1, 6.0)
		LIMIT ?`, ftsQuery, resolution.SelectedAPIVersion,
		nullableString(normalizedSection), nullableString(normalizedSection), clamped)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	matches, err := scanAPIRows(rows, true)
	if err != nil {
		return "", err
	}

	if len(matches) == 0 {
		// ── the LIKE fallback ──────────────────────────────────────────────────
		trimmed := report.TrimJS(query)
		likeRows, err := db.Query(`
			SELECT
				id,
				version,
				section,
				searchKey,
				title,
				scope,
				url,
				title AS titleSnippet,
				scope AS scopeSnippet
			FROM bannerlord_api_entries
			WHERE version = ?
				AND (? IS NULL OR section = ?)
				AND (
					title LIKE ? ESCAPE '\'
					OR searchKey LIKE ? ESCAPE '\'
					OR scope LIKE ? ESCAPE '\'
				)
			ORDER BY
				CASE
					WHEN title = ? THEN 0
					WHEN title LIKE ? THEN 1
					ELSE 2
				END,
				title
			LIMIT ?`, resolution.SelectedAPIVersion,
			nullableString(normalizedSection), nullableString(normalizedSection),
			"%"+escapeLikePattern(trimmed)+"%", "%"+escapeLikePattern(trimmed)+"%", "%"+escapeLikePattern(trimmed)+"%",
			trimmed, trimmed+"%", clamped)
		if err != nil {
			return "", err
		}
		defer likeRows.Close()
		matches, err = scanAPIRows(likeRows, false)
		if err != nil {
			return "", err
		}
	}

	blocks := make([]report.Block, 0, len(matches))
	for _, m := range matches {
		blocks = append(blocks, report.Block{
			Header: "api_match_" + report.Itoa(len(blocks)+1),
			Fields: []report.Field{
				{Key: "api_version", Value: report.Text(m.version)},
				{Key: "section", Value: report.Text(m.section)},
				{Key: "title", Value: report.Text(m.title)},
				// `row.scope || '(none)'` — an empty scope renders the placeholder.
				{Key: "scope", Value: report.Text(placeholder(m.scope, "(none)"))},
				{Key: "url", Value: report.Text(m.url)},
			},
			MultilineFields: []report.Field{
				// ★ TWO DIFFERENT FALLBACK CHAINS, and the difference is a trap: title_snippet
				// falls back to the TITLE only, while scope_snippet falls back to the SCOPE and
				// then to "(none)". So a row whose scope is empty renders `(none)` for the scope
				// field AND `(none)` for its snippet, with no third step.
				//
				// ★ The fallback query puts the RAW title and scope into the snippet columns, so on
				// the LIKE path these chains are no-ops — the value is already there. They matter on
				// the FTS path, where a snippet can come back empty for a row that matched on a
				// column outside the snippet window.
				{Key: "title_snippet", Value: firstNonEmpty(m.titleSnippet, m.title)},
				{Key: "scope_snippet", Value: firstNonEmpty(m.scopeSnippet, m.scope, "(none)")},
			},
		})
	}

	return report.Render("bannerlord_api_search", "query_text", query, blocks, []report.Field{
		{Key: "fts_query", Value: report.Text(ftsQuery)},
		{Key: "index_status", Value: report.Text("ready")},
		{Key: "installed_game_version", Value: report.Text(placeholder(resolution.InstalledGameVersion, "(unknown)"))},
		{Key: "installed_full_version", Value: report.Text(placeholder(resolution.InstalledFullVersion, "(unknown)"))},
		{Key: "requested_api_version", Value: report.Text(placeholder(resolution.RequestedAPIVersion, "(none)"))},
		{Key: "official_api_version_used", Value: report.Text(resolution.SelectedAPIVersion)},
		{Key: "api_exact_match", Value: report.Bool(resolution.ExactMatch)},
		{Key: "authority", Value: report.Text(resolution.Authority)},
		{Key: "api_usage", Value: report.Text(resolution.Usage)},
		{Key: "version_warning", Value: report.Text(placeholder(resolution.Warning, "(none)"))},
	}), nil
}

// apiRow is the common shape of both queries. withSnippets records which one produced it, because
// the fallback query returns the RAW title and scope in the snippet columns.
type apiRow struct {
	version      string
	section      string
	title        string
	scope        string
	url          string
	titleSnippet string
	scopeSnippet string
}

func scanAPIRows(rows *sql.Rows, _ bool) ([]apiRow, error) {
	out := make([]apiRow, 0, 16)
	for rows.Next() {
		var id, searchKey string
		var r apiRow
		if err := rows.Scan(&id, &r.version, &r.section, &searchKey, &r.title, &r.scope, &r.url,
			&r.titleSnippet, &r.scopeSnippet); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// normalizeAPISection mirrors normalizeSection: absent means no filter, and an unknown value also
// means NO FILTER rather than an empty result. A section name is validated against the known list,
// not merely passed through.
func normalizeAPISection(section string) string {
	if section == "" {
		return ""
	}
	if apidocs.IsSection(section) {
		return section
	}
	return ""
}

// escapeLikePattern mirrors escapeLikePattern: % and _ are escaped so a query containing them is
// matched LITERALLY. Without this, a query of "%" would match every row.
func escapeLikePattern(value string) string {
	var b strings.Builder
	b.Grow(len(value))
	for _, r := range value {
		if r == '%' || r == '_' {
			b.WriteByte('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// placeholder mirrors `value || fallback`, which is a truthiness test: an EMPTY string takes the
// fallback and a whitespace-only one does not.
func placeholder(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// firstNonEmpty mirrors an `a || b || c` chain, stopping at the first non-empty value.
func firstNonEmpty(values ...string) report.Scalar {
	for _, v := range values {
		if v != "" {
			return report.Text(v)
		}
	}
	return report.Text("")
}

// hasTableIncludingVirtual mirrors the api-docs module's private hasTable.
//
// ★ THE `virtual` ALTERNATIVE IS PRESERVED BUT CURRENTLY INDISTINGUISHABLE. The source writes
// `type IN ('table', 'virtual')` where db.ts's databaseHasTable writes `type = 'table'`. Measured
// on this sqlite (bun's bundled build and modernc both): an FTS5 table is listed in sqlite_master
// with type = 'table', so the two predicates return the same answer for every table either tool
// looks up. The wider spelling is kept because it is what the module says, and the difference would
// begin to matter on a build that reports 'virtual'.
func hasTableIncludingVirtual(db *sql.DB, tableName string) bool {
	row := db.QueryRow(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?`, tableName)
	var name string
	if err := row.Scan(&name); err != nil {
		return false
	}
	return name != ""
}
