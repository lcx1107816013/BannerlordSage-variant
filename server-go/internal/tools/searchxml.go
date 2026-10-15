package tools

import (
	"database/sql"

	"blore/internal/fts"
	"blore/internal/report"
)

// SQLite FTS5 limits the search tool imposes, mirroring src/tools/search-xml.ts.
const (
	// SearchXMLLimit mirrors the tool's `LIMIT 10`.
	SearchXMLLimit = 10
	// snippetColumn is the 0-based column passed to snippet(): 2 == `content`.
	// Changing it would silently switch the highlighted region to filePath or
	// moduleName, so it is named rather than inlined.
	snippetColumn = 2
	// snippetMarkers and snippetEllipsis mirror snippet(table, 2, '[', ']', ' ... ', 18).
	snippetOpen     = "["
	snippetClose    = "]"
	snippetEllipsis = " ... "
	snippetTokens   = 18
)

// SearchXML mirrors searchXml(query) from src/tools/search-xml.ts and returns the
// rendered report text.
//
// The FTS expression comes from fts.BuildQuery, which already has a parity suite — so this
// function is only responsible for the SQL, the row shaping and the report.
//
// ★ THE SNIPPET AND THE ORDERING COME FROM SQLITE, NOT FROM GO. snippet() with the exact
// markers and bm25() with weights (8.0, 4.0, 1.0) are evaluated by the engine. That was
// verified before porting (see tools/parity/README.md): the pure-Go driver supports FTS5,
// snippet and bm25, so no CGO and no external index is needed. Reproducing the highlighting
// in Go would be a different, much larger job, and it would diverge.
//
// ★ `row.snippet || '(no snippet)'` is mirrored exactly. The `||` is JavaScript's
// logical-OR, so an EMPTY snippet string also becomes "(no snippet)" — not just a null one.
// A Go port that checked only for "" would be fine today, but one that treated empty as
// valid would diverge, so the rule is written out rather than left to chance.
func SearchXML(db *sql.DB, query string) (string, error) {
	ftsQuery := fts.BuildQuery(query)

	rows, err := db.Query(`
		SELECT
			filePath,
			moduleName,
			snippet(xml_documents_fts, ?, ?, ?, ?, ?) AS snippet
		FROM xml_documents_fts
		WHERE xml_documents_fts MATCH ?
		ORDER BY bm25(xml_documents_fts, 8.0, 4.0, 1.0)
		LIMIT ?`,
		snippetColumn, snippetOpen, snippetClose, snippetEllipsis, snippetTokens,
		ftsQuery, SearchXMLLimit)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type match struct {
		filePath string
		module   string
		snippet  string
	}
	var matches []match
	for rows.Next() {
		var m match
		if err := rows.Scan(&m.filePath, &m.module, &m.snippet); err != nil {
			return "", err
		}
		matches = append(matches, m)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	// Zero rows: the TypeScript returns early with no blocks. This mirrors that structure,
	// but note the honest fact — the two paths are BEHAVIOURALLY EQUIVALENT here.
	// `report.Render(..., nil, ...)` and `report.Render(..., []report.Block{}, ...)` produce
	// identical text, because `len()` is 0 either way and the loop body never runs. An
	// earlier comment here claimed the difference "is visible in the output"; that was wrong,
	// and injecting `&& false` into the condition confirmed it: the suite still passed.
	//
	// The early return is kept because it mirrors the original and avoids building an empty
	// slice, NOT because it changes anything. Do not assert it as a distinguishing
	// behaviour — there is nothing to distinguish.
	topFields := []report.Field{{Key: "fts_query", Value: report.Text(ftsQuery)}}
	if len(matches) == 0 {
		return report.Render("xml_search", "query_text", query, nil, topFields), nil
	}

	blocks := make([]report.Block, 0, len(matches))
	for i, m := range matches {
		snippet := m.snippet
		if snippet == "" {
			snippet = "(no snippet)"
		}
		blocks = append(blocks, report.Block{
			Header: "match_" + itoa(i+1),
			Fields: []report.Field{
				{Key: "module_name", Value: report.Text(m.module)},
				{Key: "file_path", Value: report.Text(m.filePath)},
			},
			MultilineFields: []report.Field{
				{Key: "snippet", Value: report.Text(snippet)},
			},
		})
	}

	return report.Render("xml_search", "query_text", query, blocks, topFields), nil
}

// itoa is a small local formatter. strconv would do, but the value is only ever a small
// positive index, and keeping it local avoids the import for one call site.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
