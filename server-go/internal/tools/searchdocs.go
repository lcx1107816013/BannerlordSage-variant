package tools

import (
	"database/sql"

	"blore/internal/fts"
	"blore/internal/report"
)

// DocsSourceFilter mirrors DocsSourceFilter.
type DocsSourceFilter = string

// SearchDocs mirrors searchDocs from src/tools/search-docs.ts.
//
// ★ THE MISSING-INDEX CASE IS A REPORT, NOT AN ERROR. When `bannerlord_docs_fts` is absent the tool
// returns a report with NO blocks and two top fields — index_status "missing" and a setup_hint
// naming the indexing command. A port that returned an error would turn "not indexed yet" into a
// failure, and a caller could not tell that apart from a broken index.
//
// ★ THE FTS QUERY COMES FROM THE SHARED BUILDER. Both search tools carry a private copy of
// buildFtsQuery; internal/fts holds the ported one, and its comment records that a hand-written test
// once "fixed" correct code into a defect (F12). This file CALLS fts.BuildQuery rather than growing
// a second implementation — the shape F25 records for the sibling repository.
//
// ★ THE FILTER VALUE AND THE RENDERED VALUE ARE DIFFERENT STRINGS. The SQL parameter is NULL for
// "all" (and for anything unrecognised), while the report renders the CALLER'S value verbatim. So a
// caller passing "own" sees `source_filter: own` while the query filters on `own_knowledge`, and an
// unrecognised value is not an error: it stops filtering and still renders as itself.
func SearchDocs(db *sql.DB, query string, source DocsSourceFilter, limit int) (string, error) {
	if !hasPlainTable(db, "bannerlord_docs_fts") {
		return report.Render("bannerlord_docs_search", "query_text", query, nil, []report.Field{
			{Key: "index_status", Value: report.Text("missing")},
			{Key: "setup_hint", Value: report.Text("Run bun run index:own-docs first (external docs: bun run index:docs).")},
		}), nil
	}

	ftsQuery := fts.BuildQuery(query)
	normalizedSource := normalizeDocsSourceFilter(source)
	clamped := ClampDocsLimit(limit)

	rows, err := db.Query(`
		SELECT
			id,
			source,
			language,
			category,
			title,
			url,
			snippet(bannerlord_docs_fts, 6, '[', ']', ' ... ', 28) AS snippet
		FROM bannerlord_docs_fts
		WHERE bannerlord_docs_fts MATCH ?
			AND (? IS NULL OR source = ?)
		ORDER BY bm25(bannerlord_docs_fts, 0.5, 0.5, 0.5, 2.0, 8.0, 0.1, 1.0)
		LIMIT ?`, ftsQuery, nullableString(normalizedSource), nullableString(normalizedSource), clamped)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	blocks := make([]report.Block, 0, clamped)
	for rows.Next() {
		var id, src, language, category, title, url string
		// ★ snippet() CAN RETURN NULL, AND A PLAIN string SCAN ERRORS ON IT. Measured: the function
		// yields NULL when the source column is NULL and "" when it is empty — and the differential
		// caught this port crashing on the NULL case the moment a fixture row with a NULL body was
		// added, because `rows.Scan` refuses to convert NULL into a string. The TypeScript never sees
		// a problem: `row.snippet || '(no snippet)'` treats null and "" alike, which is precisely
		// why the guard is written that way.
		var snippet sql.NullString
		if err := rows.Scan(&id, &src, &language, &category, &title, &url, &snippet); err != nil {
			return "", err
		}
		blocks = append(blocks, report.Block{
			// Numbered from the accumulated length, so the labels are 1-based and dense.
			Header: "doc_match_" + report.Itoa(len(blocks)+1),
			Fields: []report.Field{
				{Key: "source", Value: report.Text(src)},
				{Key: "language", Value: report.Text(language)},
				{Key: "category", Value: report.Text(category)},
				{Key: "title", Value: report.Text(title)},
				{Key: "url", Value: report.Text(url)},
			},
			// `row.snippet || '(no snippet)'` is a truthiness guard, so it fires for BOTH a NULL
			// snippet and an empty one; a whitespace-only snippet survives it and is trimmed to the
			// `unknown` fallback by the renderer instead.
			MultilineFields: []report.Field{{Key: "snippet", Value: snippetOrPlaceholder(snippet)}},
		})
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	return report.Render("bannerlord_docs_search", "query_text", query, blocks, []report.Field{
		{Key: "fts_query", Value: report.Text(ftsQuery)},
		{Key: "source_filter", Value: report.Text(source)},
		{Key: "index_status", Value: report.Text("ready")},
	}), nil
}

// normalizeDocsSourceFilter mirrors normalizeSourceFilter.
//
// The mapping is the whole function: three known filters map to table values and EVERYTHING ELSE
// maps to no filter at all. There is no validation and no error.
func normalizeDocsSourceFilter(source DocsSourceFilter) string {
	switch source {
	case "own":
		return "own_knowledge"
	case "official":
		return "official_moddocs"
	case "community":
		return "community_modding_docs"
	}
	return ""
}

// Limits for search_docs, mirroring clampLimit's constants in src/tools/search-docs.ts.
//
// ★ THE TWO SEARCH TOOLS DISAGREE ON PURPOSE, AND THE DEFAULTS ARE NOT ONLY IN THE CLAMP. In the
// TypeScript search_docs declares `limit = 8` in its SIGNATURE and again writes 8 in clampLimit;
// search_api_docs declares `limit = 10` and writes 10, with ceilings 25 and 30. Here the constant is
// the single source for both the caller-visible default and the unusable-value fallback.
const (
	DefaultDocsLimit = 8
	MaxDocsLimit     = 25
)

// ClampDocsLimit mirrors clampLimit (docs).
//
// ★ MEASURED with bun 1.4.3, because the shape is not the obvious one:
//
//	0, 1, -5, -0.5  -> 1      (the LOWER bound wins; a negative limit is NOT the default)
//	9.9             -> 9      (Math.floor runs BEFORE the clamp)
//	26, 100         -> 25     (the ceiling)
//	NaN, ±Infinity  -> 8      (an UNUSABLE value takes the default; a negative one does not)
//
// The unusable branch cannot be reached through a Go int, so it is expressed as the constant a
// caller passes rather than as dead code: `ClampDocsLimit(DefaultDocsLimit)` is 8 either way, and a
// caller that means "unusable" passes that constant deliberately.
func ClampDocsLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	if limit > MaxDocsLimit {
		return MaxDocsLimit
	}
	return limit
}

// nullableString maps "" to NULL, which is what the `? IS NULL` branch needs.
func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// snippetOrPlaceholder mirrors `row.snippet || '(no snippet)'`.
//
// ★ IT TAKES A NullString BECAUSE THE COLUMN CAN BE NULL. Measured with bun 1.4.3 and the sqlite it
// bundles: `snippet()` returns "" for a source column that is an empty string and NULL for one that
// is NULL, and the JavaScript guard collapses both to the placeholder. A plain Go string cannot
// represent the second case — the scan errors before this function is reached.
func snippetOrPlaceholder(snippet sql.NullString) report.Scalar {
	if !snippet.Valid || snippet.String == "" {
		return report.Text("(no snippet)")
	}
	return report.Text(snippet.String)
}

// hasPlainTable mirrors databaseHasTable from src/utils/db.ts: `WHERE type = 'table' AND name = ?`,
// wrapped in a try/catch that returns false on ANY error (including a missing file, which is why a
// not-yet-created database reads as "no table" rather than as a failure).
//
// ★ THE 'virtual' DISTINCTION IS REAL IN THE SOURCE BUT UNOBSERVABLE ON THIS SQLITE. The api-docs
// module's private hasTable writes `type IN ('table', 'virtual')`, and the two predicates genuinely
// differ as SQL. But sqlite registers an FTS5 (or rtree) table in sqlite_master with type = 'table',
// not 'virtual' — MEASURED, both in a synthetic database and in the real 600 MB index, where
// bannerlord_docs_fts and its five shadow tables all report type 'table' and the only other type
// present is 'index'. So the wider predicate admits the same rows as the narrower one for every
// table these tools look up, and the port keeps each source's own spelling rather than "unifying"
// two predicates whose difference cannot be demonstrated. If a future sqlite reports 'virtual',
// the wider form starts mattering — which is exactly why it is preserved and this note exists.
func hasPlainTable(db *sql.DB, tableName string) bool {
	row := db.QueryRow(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, tableName)
	var name string
	if err := row.Scan(&name); err != nil {
		return false
	}
	return name != ""
}
