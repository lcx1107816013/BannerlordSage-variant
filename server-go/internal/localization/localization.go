// Package localization mirrors src/utils/localization.ts: it resolves a Bannerlord
// localization token like `{=abc123}Fallback text` into real strings, preferring a caller's
// language order and falling back to the token's own inline text.
package localization

import (
	"database/sql"
	"strings"

	"blore/internal/report"
)

// tokenPrefix/suffix mirror TOKEN_REGEX = /^\{=([^}]+)\}(.*)$/
//
// ★ The regex is ANCHORED at the start and NOT at the end, and the id pattern excludes `}`.
// Two consequences a looser implementation would get wrong: a string containing a token in the
// MIDDLE is not a token (so it is returned unchanged), and the trailing `(.*)` is greedy to the
// end of the string, so everything after the first `}` is fallback text — including any further
// braces.
const (
	tokenOpen  = "{="
	tokenClose = "}"
)

// ParseLocalizationToken mirrors parseLocalizationToken. Returns ok=false for a non-token.
//
// Note the fallback is `match[2] || ”`, so an empty tail yields an EMPTY STRING rather than
// being treated as absent. That distinction is visible: it decides whether a later
// `token?.fallback` check passes.
//
// ★ THE TAIL MUST NOT CONTAIN A LINE TERMINATOR, and that is a CORRECTED DEFECT rather than
// original behaviour. The TypeScript is `text.match(/^\{=([^}]+)\}(.*)$/)` with no flags, and
// in ECMAScript a `.` excludes LF, CR, U+2028 and U+2029 while `$` (non-multiline) matches
// only at the very END of the input. So a tail spanning or ending with a terminator makes the
// WHOLE match fail:
//
//	{=abc}Continue\nSecond line   ts: not a token   (was) go: a token
//	{=abc}Continue\r\n             ts: not a token   (was) go: a token
//	{=abc}Continue\n               ts: not a token   (was) go: a token
//	{=abc}Continue\u2028           ts: not a token   (was) go: a token
//	{=abc}Continue\u000b           ts: A token       go: a token   (VT is not a terminator)
//	{=abc}Continue\u0085           ts: A token       go: a token   (NEL is not a terminator)
//
// Measured by running the real regex under bun 1.4.3, not by reading the spec. The id capture
// is unaffected — `[^}]` DOES admit a line terminator, so `{=a\nb}tail` is a token in both —
// which is why the check below is on the TAIL only.
//
// This was invisible until a fixture corpus was built that contained the inputs: every
// existing corpus case was single-line, so both implementations agreed and the divergence
// could not be observed. A token pasted together with the following line is exactly the
// malformed input the tool's early return exists to catch.
func ParseLocalizationToken(text string) (id, fallback string, ok bool) {
	if text == "" {
		return "", "", false
	}
	if !strings.HasPrefix(text, tokenOpen) {
		return "", "", false
	}
	rest := text[len(tokenOpen):]
	idx := strings.Index(rest, tokenClose)
	if idx < 0 {
		return "", "", false
	}
	// `[^}]+` requires at least one character before the closing brace.
	if idx == 0 {
		return "", "", false
	}
	tail := rest[idx+1:]
	if strings.ContainsAny(tail, "\n\r\u2028\u2029") {
		return "", "", false
	}
	return rest[:idx], tail, true
}

// canonicalLanguageAliases mirrors CANONICAL_LANGUAGE_ALIASES exactly, including which
// aliases are grouped together. The groups are the contract: an unknown language code falls
// through to being its own canonical form, which is how a new game language still works.
var canonicalLanguageAliases = []struct {
	canonical string
	aliases   []string
}{
	{"english", []string{"english", "en"}},
	{"chinese_simplified", []string{
		"cn", "cns", "chs", "sc", "zh", "zhcn", "zhhans", "zh-hans",
		"simplifiedchinese", "chinesesimplified",
	}},
	{"chinese_traditional", []string{
		"cnt", "cht", "tc", "zhtw", "zhhk", "zhhant", "zh-hant",
		"traditionalchinese", "chinesetraditional",
	}},
	{"portuguese", []string{"br", "portuguese", "pt", "ptbr"}},
	{"german", []string{"de", "german"}},
	{"french", []string{"fr", "french"}},
	{"italian", []string{"it", "italian"}},
	{"japanese", []string{"jp", "japanese"}},
	{"korean", []string{"ko", "korean"}},
	{"polish", []string{"pl", "polish"}},
	{"russian", []string{"ru", "russian"}},
	{"spanish", []string{"sp", "es", "spanish"}},
	{"turkish", []string{"tr", "turkish"}},
}

// normalizeLanguageKey mirrors
// `(language || ”).trim().toLowerCase().replace(/[\s_-]+/g, ”)`.
//
// ★ The `[\s_-]+` class is applied AFTER lowercasing, and it removes underscores and hyphens as
// well as whitespace, so `zh_hans` and `zh-hans` and `zhhans` all collapse to the same key. And
// `\s` here is the ECMASCRIPT whitespace set, not Go's — hence report.TrimJS.
func normalizeLanguageKey(language string) string {
	trimmed := report.TrimJS(language)
	lowered := strings.ToLower(trimmed)
	var b strings.Builder
	b.Grow(len(lowered))
	for _, r := range lowered {
		if r == '_' || r == '-' || isJSWhitespaceRune(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// isJSWhitespaceRune tests membership of the ECMAScript whitespace set for a single rune.
//
// Go's regexp does not accept \p{White_Space}, and strings.ContainsRune on the constant set
// would also match a rune that merely shares a byte prefix — so the set is enumerated. It must
// stay in step with report's jsWhitespace; both are the same ECMAScript definition.
func isJSWhitespaceRune(r rune) bool {
	switch r {
	case '\u0009', '\u000a', '\u000b', '\u000c', '\u000d', '\u0020', '\u00a0', '\u1680',
		'\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return r >= '\u2000' && r <= '\u200a'
}

// canonicalLanguage mirrors getCanonicalLanguage. It returns ok=false for an empty key.
//
// ★ The `startsWith('std')` case is not incidental: the indexer stores the SOURCE file's name
// (e.g. `std_SandBox.xml`) in the `language` column for English text, so this prefix test is the
// only thing that classifies the entire English source corpus as English. Verified against the
// live index, whose language column really does hold `std_NavalDLC.xml` and friends.
func canonicalLanguage(language string) (string, bool) {
	normalized := normalizeLanguageKey(language)
	if normalized == "" {
		return "", false
	}
	if strings.HasPrefix(normalized, "std") {
		return "english", true
	}
	for _, group := range canonicalLanguageAliases {
		for _, alias := range group.aliases {
			if normalizeLanguageKey(alias) == normalized {
				return group.canonical, true
			}
		}
	}
	return normalized, true
}

// buildPreferredLanguageOrder mirrors buildPreferredLanguageOrder: the caller's languages
// (canonicalised, de-duplicated, in order) followed by the three built-in fallbacks.
func buildPreferredLanguageOrder(preferred []string) []string {
	result := make([]string, 0, len(preferred)+3)
	seen := map[string]struct{}{}
	add := func(v string) {
		if _, ok := seen[v]; ok {
			return
		}
		seen[v] = struct{}{}
		result = append(result, v)
	}
	for _, language := range preferred {
		if canonical, ok := canonicalLanguage(language); ok {
			add(canonical)
		}
	}
	for _, fallback := range []string{"chinese_simplified", "chinese_traditional", "english"} {
		add(fallback)
	}
	return result
}

// languageRank mirrors getLocalizationLanguageRank: an unranked language sorts after every
// ranked one, and all unranked languages share the same rank so their relative order is decided
// by the next sort key.
func languageRank(language string, preferred []string) int {
	order := buildPreferredLanguageOrder(preferred)
	canonical, ok := canonicalLanguage(language)
	if !ok {
		return len(order) + 1
	}
	for i, candidate := range order {
		if candidate == canonical {
			return i
		}
	}
	return len(order) + 1
}

// XMLEntry is one row of localization_entries.
type XMLEntry struct {
	Language string
	Text     string
	FilePath string
}

// SourceEntry is one row of source_localization_entries.
type SourceEntry struct {
	FallbackText   string
	FilePath       string
	ModuleName     string
	AssemblyName   string
	LineNumber     int
	ColumnNumber   int
	ContextKind    string
	SourcePriority int
}

// Details mirrors LocalizationDetails.
type Details struct {
	StringID      string
	TokenFallback string
	HasToken      bool
	XMLEntries    []XMLEntry
	SourceEntries []SourceEntry
}

// ResolveLocalizationDetails mirrors resolveLocalizationDetails.
//
// ★ THE ID NORMALISATION IS NOT WHAT IT LOOKS. For a non-token input the id is
// `tokenOrId.replace(/[{}=]/g, ”).trim()` — braces and equals signs are stripped from
// ANYWHERE in the string, not just the ends, and the trim happens after. So `"==abc{"` becomes
// `"abc"`. A port that only stripped a prefix would silently query a different key.
//
// ★ ORDERING. SQL orders by `language, filePath`, and Go then re-sorts by (rank, language,
// filePath). The Go sort is a STABLE sort applied to an already-ordered slice, and for the
// realistic language set the rank dominates — measured: `localeCompare` and code-unit order
// agree on every pair of the languages the game actually ships (0 disagreements in 132 pairs),
// so the language tie-break is safe to express as a byte comparison.
//
// The `filePath` tie-break is NOT safe, and is handled by report.FilePathCompare — see the note
// there.
func ResolveLocalizationDetails(db *sql.DB, tokenOrID string, preferred []string) (Details, error) {
	var details Details

	id := ""
	if tokenID, fallback, ok := ParseLocalizationToken(tokenOrID); ok {
		id = tokenID
		details.TokenFallback = fallback
		details.HasToken = true
	} else {
		id = stripBracesAndEquals(tokenOrID)
	}
	details.StringID = id

	rows, err := db.Query(`
		SELECT language, text, filePath
		FROM localization_entries
		WHERE stringId = ?
		ORDER BY language, filePath`, id)
	if err != nil {
		return details, err
	}
	defer rows.Close()
	for rows.Next() {
		var e XMLEntry
		if err := rows.Scan(&e.Language, &e.Text, &e.FilePath); err != nil {
			return details, err
		}
		details.XMLEntries = append(details.XMLEntries, e)
	}
	if err := rows.Err(); err != nil {
		return details, err
	}

	// ★ The source table is OPTIONAL — it exists only in some index revisions, and the
	// TypeScript gates on its presence rather than catching an error. Checking
	// sqlite_master first keeps that behaviour: an absent table yields an empty list, not a
	// failure.
	if hasTable(db, "source_localization_entries") {
		srcRows, err := db.Query(`
			SELECT fallbackText, filePath, moduleName, assemblyName, lineNumber, columnNumber,
			       contextKind, sourcePriority
			FROM source_localization_entries
			WHERE stringId = ?
			ORDER BY sourcePriority, moduleName, assemblyName, filePath, lineNumber, columnNumber`, id)
		if err != nil {
			return details, err
		}
		defer srcRows.Close()
		for srcRows.Next() {
			var e SourceEntry
			if err := srcRows.Scan(&e.FallbackText, &e.FilePath, &e.ModuleName, &e.AssemblyName,
				&e.LineNumber, &e.ColumnNumber, &e.ContextKind, &e.SourcePriority); err != nil {
				return details, err
			}
			details.SourceEntries = append(details.SourceEntries, e)
		}
		if err := srcRows.Err(); err != nil {
			return details, err
		}
	}

	// Stable sort, mirroring the TypeScript's Array.prototype.sort (which is stable in every
	// engine that matters) over an already-SQL-ordered slice.
	stableSortBy(details.XMLEntries, func(a, b XMLEntry) int {
		if d := languageRank(a.Language, preferred) - languageRank(b.Language, preferred); d != 0 {
			return d
		}
		if d := report.CompareCodeUnits(a.Language, b.Language); d != 0 {
			return d
		}
		return report.FilePathCompare(a.FilePath, b.FilePath)
	})

	return details, nil
}

// ResolveLocalizationMap mirrors resolveLocalizationMap.
//
// Two rules that are easy to invert: an already-present key is never overwritten (so the FIRST
// entry wins for both the raw language and its canonical name), and each mapping is set only if
// still empty.
func ResolveLocalizationMap(db *sql.DB, tokenOrID string, preferred []string) (map[string]string, error) {
	details, err := ResolveLocalizationDetails(db, tokenOrID, preferred)
	if err != nil {
		return nil, err
	}
	mapping := map[string]string{}

	for _, row := range details.XMLEntries {
		if _, ok := mapping[row.Language]; !ok {
			mapping[row.Language] = row.Text
		}
		if canonical, ok := canonicalLanguage(row.Language); ok {
			if _, present := mapping[canonical]; !present {
				mapping[canonical] = row.Text
			}
		}
	}

	if len(details.SourceEntries) > 0 && details.SourceEntries[0].FallbackText != "" {
		if _, ok := mapping["sourceFallback"]; !ok {
			mapping["sourceFallback"] = details.SourceEntries[0].FallbackText
		}
	}
	if details.HasToken && details.TokenFallback != "" {
		if _, ok := mapping["fallback"]; !ok {
			mapping["fallback"] = details.TokenFallback
		}
	}
	return mapping, nil
}

// ResolveMaybeLocalizedText mirrors resolveMaybeLocalizedText.
//
// ★ THE RETURN SHAPE IS THE ODD PART, and it is deliberate in the original: when a translation
// is found the result is `"<text> ({=id})"` — the resolved string WITH the token appended in
// parentheses. A port that returned the plain translation would look tidier and would break
// every getter's output, since this value feeds `display_name`.
//
// ★ RECURSION. The chosen value may itself be a token, and the function calls itself on it. In
// the live index only ONE localization entry has a `{=...}` value, so this terminates in
// practice; the recursion depth is bounded by the data, as in the original.
func ResolveMaybeLocalizedText(db *sql.DB, rawText string, preferred []string) (string, error) {
	if rawText == "" {
		return "unknown", nil
	}
	tokenID, tokenFallback, isToken := ParseLocalizationToken(rawText)
	if !isToken {
		return rawText, nil
	}

	mapping, err := ResolveLocalizationMap(db, rawText, preferred)
	if err != nil {
		return "", err
	}

	finalText := ""
	for _, language := range buildPreferredLanguageOrder(preferred) {
		if v, ok := mapping[language]; ok && v != "" {
			finalText = v
			break
		}
	}
	if finalText == "" {
		finalText = mapping["sourceFallback"]
	}
	if finalText == "" {
		finalText = tokenFallback
	}
	if finalText == "" {
		return rawText, nil
	}
	return finalText + " ({=" + tokenID + "})", nil
}

// stripBracesAndEquals mirrors `tokenOrId.replace(/[{}=]/g, ”).trim()`.
func stripBracesAndEquals(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	for _, r := range s {
		if r == '{' || r == '}' || r == '=' {
			continue
		}
		b.WriteRune(r)
	}
	return report.TrimJS(b.String())
}

// hasTable mirrors the TypeScript's sqlite_master probe.
func hasTable(db *sql.DB, name string) bool {
	var found string
	err := db.QueryRow(
		`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`, name).Scan(&found)
	return err == nil
}

// stableSortBy is an insertion sort used deliberately: the slices are tiny (a handful of
// localization entries), and a stable sort keeps ties in the order SQL produced, which the
// TypeScript relies on too. sort.SliceStable would serve, but this keeps the comparator contract
// explicit and avoids the reflection.
func stableSortBy[T any](items []T, cmp func(a, b T) int) {
	for i := 1; i < len(items); i++ {
		for j := i; j > 0 && cmp(items[j-1], items[j]) > 0; j-- {
			items[j-1], items[j] = items[j], items[j-1]
		}
	}
}
