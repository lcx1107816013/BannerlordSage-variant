package tools

import (
	"database/sql"
	"strings"

	"blore/internal/localization"
	"blore/internal/report"
)

const (
	// notATokenMessage is the ENTIRE output when the input does not parse as a token — no
	// report wrapper, no database access. The wording and punctuation are the tool's contract,
	// so it is stored verbatim rather than assembled from pieces.
	notATokenMessage = "Input text is not a Bannerlord localization token. Expected format: {=str_id}Fallback Text"

	// sourceEntriesShown mirrors the `.slice(0, 10)` on the source-entry list. Only the
	// rendered items are limited by it; the counts use the full length.
	sourceEntriesShown = 10

	// emptyFallbackWord mirrors the `|| '(empty)'` placeholder for the token's inline text.
	emptyFallbackWord = "(empty)"
	// unknownFilePathWord mirrors the `|| 'unknown'` placeholder for an XML row's file path.
	unknownFilePathWord = "unknown"
	// defaultLanguagesWord mirrors the `|| 'default'` placeholder for the language list.
	defaultLanguagesWord = "default"
)

// ResolveLocalization mirrors resolveLocalization(text, languages) from
// src/tools/resolve-localization.ts and returns the rendered report text.
//
// It is a shaping layer over localization.ResolveLocalizationDetails: the token is parsed here
// as well as inside the helper, then every value is formatted into the report. The rules below
// are the ones that are easy to port wrongly.
func ResolveLocalization(db *sql.DB, text string, languages []string) (string, error) {
	tokenID, tokenFallback, ok := localization.ParseLocalizationToken(text)
	if !ok {
		return notATokenMessage, nil
	}

	details, err := localization.ResolveLocalizationDetails(db, text, languages)
	if err != nil {
		// The TypeScript calls a synchronous helper, so a database failure would throw out of
		// the tool; a Go error is that same signal at this boundary.
		return "", err
	}

	// ★ `token.fallback || '(empty)'` IS A TRUTHINESS TEST ON THE PARSED TAIL, so ONLY the
	// empty string becomes the placeholder: `{=abc}` renders `(empty)`. `{=abc}   ` keeps its
	// spaces here and is trimmed to nothing by the renderer, which then prints `unknown` —
	// NOT `(empty)`.
	if tokenFallback == "" {
		tokenFallback = emptyFallbackWord
	}

	block := report.Block{
		// The source sets this header, so the renderer emits `result_label: localization_summary`.
		Header: "localization_summary",
		Fields: []report.Field{
			{Key: "localization_id", Value: report.Text(tokenID)},
			{Key: "query_text", Value: report.Text(text)},
			{Key: "token_fallback", Value: report.Text(tokenFallback)},
			{Key: "preferred_languages", Value: report.Text(preferredLanguagesLabel(languages))},
			{Key: "xml_entry_count", Value: report.Number(float64(len(details.XMLEntries)))},
			{Key: "source_entry_count", Value: report.Number(float64(len(details.SourceEntries)))},
		},
		ListFields: []report.ListField{
			{Key: "xml_entries", Values: xmlEntryLines(details.XMLEntries)},
			{Key: "source_entries", Values: sourceEntryLines(details.SourceEntries)},
		},
	}

	// ★ THE EXTRA FIELD IS APPENDED TO `Fields`, NOT TO A LIST, and the renderer prints every
	// scalar field before any list field. So in the output `source_entries_omitted` lands
	// directly under `source_entry_count`, ABOVE the `xml_entries`/`source_entries` lists,
	// even though the push reads as if it followed them.
	//
	// Both this count and `source_entry_count` are the FULL length, taken before the
	// slice(0, 10) that produced the `source_entries` items.
	if len(details.SourceEntries) > sourceEntriesShown {
		block.Fields = append(block.Fields, report.Field{
			Key:   "source_entries_omitted",
			Value: report.Number(float64(len(details.SourceEntries) - sourceEntriesShown)),
		})
	}

	return report.Render("localization_resolution", "query_localization_token", text,
		[]report.Block{block}, nil), nil
}

// preferredLanguagesLabel mirrors `languages?.join(', ') || 'default'`.
//
// ★ THE TEST IS ON THE JOINED RESULT, not on the list: a nil slice, an EMPTY slice and a
// one-element list holding "" all render 'default', because all three join to "". But
// ["DE", ""] joins to "DE, " — truthy, with the empty element still contributing its
// separator — and the renderer then trims that trailing space, printing `DE,`. A list of a
// single space joins to " ", is truthy, and trims to "" inside the renderer, which prints
// `unknown` rather than 'default'.
func preferredLanguagesLabel(languages []string) string {
	joined := strings.Join(languages, ", ")
	if joined == "" {
		return defaultLanguagesWord
	}
	return joined
}

// xmlEntryLines builds the `xml_entries` items: `language=<l> | text=<t> | file_path=<p>`.
//
// ★ `row.filePath || 'unknown'`: an EMPTY path becomes the word, while a whitespace-only path
// does not — it passes through and is instead swallowed by the renderer's trim of the whole
// line, leaving a bare `file_path=`.
func xmlEntryLines(entries []localization.XMLEntry) []report.Scalar {
	values := make([]report.Scalar, 0, len(entries))
	for _, row := range entries {
		filePath := row.FilePath
		if filePath == "" {
			filePath = unknownFilePathWord
		}
		values = append(values, report.Text(
			"language="+row.Language+" | text="+row.Text+" | file_path="+filePath))
	}
	return values
}

// sourceEntryLines builds the `source_entries` items, capped at the first sourceEntriesShown.
//
// ★ `row.lineNumber + 1` and `row.columnNumber + 1` are the original's arithmetic: the index
// stores 0-based positions and the report renders them 1-based. The `+ 1` is not a correction.
//
// ★ ASYMMETRY WITH xmlEntryLines, which is in the source and not a slip here: this line has NO
// `|| 'unknown'` guard on filePath, so a source row with an empty path renders an empty
// segment — `file_path=:1:1`.
func sourceEntryLines(entries []localization.SourceEntry) []report.Scalar {
	limit := len(entries)
	if limit > sourceEntriesShown {
		limit = sourceEntriesShown
	}
	values := make([]report.Scalar, 0, limit)
	for _, row := range entries[:limit] {
		values = append(values, report.Text(
			"fallback_text="+row.FallbackText+
				" | context_kind="+row.ContextKind+
				" | assembly="+row.AssemblyName+
				" | file_path="+row.FilePath+
				":"+report.Itoa(row.LineNumber+1)+
				":"+report.Itoa(row.ColumnNumber+1)))
	}
	return values
}
