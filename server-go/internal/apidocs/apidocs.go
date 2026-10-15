// Package apidocs ports src/utils/bannerlord-api-docs.ts: the version resolution behind
// search_api_docs.
//
// ★ WHAT THIS DECIDES, AND WHY IT IS NOT COSMETIC. The tool answers questions about a versioned
// public API, and the index may cover several versions. This module decides WHICH version a query
// runs against, and whether the answer carries any authority — `official_api_reference` when the
// selected version is the one actually installed, `local_decompiled_source` otherwise. A wrong
// selection is not a wrong string, it is an answer attributed to the wrong authority.
//
// ★ THE INDEXING FUNCTIONS ARE NOT HERE. `index-api-docs` fetches the site, and the ledger records
// that apidoc.bannerlord.com fails for this machine (F20). Nothing in this file touches the network.
package apidocs

import (
	"database/sql"
	"sort"
	"strings"

	"blore/internal/report"
)

// Sections mirrors BANNERLORD_API_SECTIONS.
var Sections = []string{
	"classes",
	"functions",
	"properties",
	"events",
	"enums",
	"enumvalues",
	"variables",
}

// IsSection reports whether a value is one of the known sections.
func IsSection(value string) bool {
	for _, s := range Sections {
		if s == value {
			return true
		}
	}
	return false
}

// VersionResolution mirrors BannerlordApiVersionResolution.
type VersionResolution struct {
	InstalledGameVersion string
	InstalledFullVersion string
	RequestedAPIVersion  string
	SelectedAPIVersion   string
	HasSelection         bool
	ExactMatch           bool
	Authority            string
	Usage                string
	Warning              string
	HasWarning           bool
	AvailableVersions    []string
}

// ecmaWhitespace is the ECMAScript WhiteSpace + LineTerminator set, which is what JavaScript's
// parseInt skips before it looks for a sign.
//
// ★ IT IS NOT Go's unicode.IsSpace. The two disagree in BOTH directions: JS skips U+FEFF (the
// BOM/ZWNBSP) and Go does not; Go skips U+0085 (NEL) and JS does not. internal/report holds the
// same set for `.trim()`; it is spelled out again here rather than exported from there because one
// unexported constant is not worth widening that package's API.
const ecmaWhitespace = "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007" +
	"\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"

// stripLeadingVersionPrefix mirrors `value.replace(/^v/i, ”)`: EXACTLY ONE leading "v" or "V".
//
// ★ TWO CHAINED strings.TrimPrefix CALLS ARE NOT EQUIVALENT, and the difference is measured rather
// than theoretical: "vV1.2.9" becomes "V1.2.9" in the TypeScript (one character removed) and
// "1.2.9" with the chained form (two). So the strip is written as a single-character test.
func stripLeadingVersionPrefix(value string) string {
	if value != "" && (value[0] == 'v' || value[0] == 'V') {
		return value[1:]
	}
	return value
}

// NormalizeAPIVersion mirrors normalizeApiVersion: "v1.2.9.x" becomes "1.2.9".
//
// ★ IT IS NOT A VALIDATOR. With FEWER than three dot-separated parts the value comes back joined
// AS-IS, so "1.2" stays "1.2" and "a.b.c" stays "a.b.c" — a string that is not a version at all
// passes through unchanged and is then compared as one. With three or MORE parts only the first
// three survive. Empty parts are dropped BEFORE the length test, so "1..2" (three fields, one
// empty) is treated as the two-part value "1.2".
//
// ★ THE `v` STRIP IS CASE-INSENSITIVE AND ANCHORED: only a leading "v"/"V" is removed, and exactly
// once. "vv1.2" loses one.
//
// Returns "" for an absent, empty or whitespace-only value; the caller treats "" as "not
// requested". The trim is JavaScript's, not Go's TrimSpace.
func NormalizeAPIVersion(value string) string {
	cleaned := stripLeadingVersionPrefix(report.TrimJS(value))
	if cleaned == "" {
		return ""
	}

	// Split, trim each part, drop the empties — in that order, which is why "1..2" collapses.
	rawParts := strings.Split(cleaned, ".")
	parts := make([]string, 0, len(rawParts))
	for _, part := range rawParts {
		if trimmed := report.TrimJS(part); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}

	if len(parts) < 3 {
		return strings.Join(parts, ".")
	}
	return strings.Join(parts[:3], ".")
}

// CompareAPIVersions mirrors compareApiVersions: a numeric comparison over up to three parts, where
// an absent part counts as 0.
//
// The result is the numeric DELTA, not a normalised -1/0/1: the TypeScript returns `delta` directly,
// and a caller comparing `> 0` or `< 0` cannot tell the difference, but one comparing `=== 1` can.
// The exact value is preserved rather than normalised, because nothing here should decide for the
// caller which of those it is.
func CompareAPIVersions(left, right string) int {
	leftParts := ParseVersionParts(left)
	rightParts := ParseVersionParts(right)
	length := len(leftParts)
	if len(rightParts) > length {
		length = len(rightParts)
	}

	for index := 0; index < length; index++ {
		var l, r int
		if index < len(leftParts) {
			l = leftParts[index]
		}
		if index < len(rightParts) {
			r = rightParts[index]
		}
		if delta := l - r; delta != 0 {
			return delta
		}
	}
	return 0
}

// ParseVersionParts mirrors parseVersionParts: strip a leading v, split on dots, apply
// JavaScript's Number.parseInt(part, 10), and replace a non-finite result with 0.
//
// ★ parseInt IS NOT Atoi, AND THE DIFFERENCE IS OBSERVABLE ON REALISTIC INPUT. Measured under bun
// 1.4.3:
//
//	"1"    -> 1      "01"  -> 1     (leading zeros are not octal)
//	"1a"   -> 1      "9x9" -> 9     <-- a TRAILING GARBAGE SUFFIX IS SILENTLY DROPPED
//	"1.9"  -> 1      "1e3" -> 1     <-- NOT 1000: parseInt stops at the 'e'
//	"0x10" -> 0      "+2"  -> 2     <-- NOT 16: base 10 refuses the 0x prefix
//	"-1"   -> -1     "abc" -> NaN -> 0, "" -> NaN -> 0, " " -> NaN -> 0
//
// So a version segment like "9rc1" compares as 9, and "1e3" compares as 1. strconv.Atoi would
// reject both and, with the ordinary "on error use 0" fallback, silently produce a DIFFERENT
// comparison for "1a" — 0 instead of 1.
//
// ★ THE TRIMMING HAPPENS INSIDE parseInt, NOT BEFORE: it skips leading whitespace itself, which is
// why " 1" parses as 1 here while the empty-after-trim case still yields 0.
func ParseVersionParts(value string) []int {
	cleaned := stripLeadingVersionPrefix(value)
	fields := strings.Split(cleaned, ".")
	out := make([]int, 0, len(fields))
	for _, field := range fields {
		out = append(out, parseJSInt(field))
	}
	return out
}

// parseJSInt mirrors Number.parseInt(value, 10) followed by the `Number.isFinite ? : 0` repair.
//
// The scan accepts an optional sign, then digits, and IGNORES everything after them. A string with
// no digits at all (including "") yields 0, which is what the repair does to NaN. Note that the
// result is a float64 in JavaScript, so a value beyond 2^53 would lose precision; version segments
// are small integers, and this port uses int for them, so the two agree on every input a version
// string can carry.
//
// ★ parseInt SKIPS LEADING WHITESPACE ITSELF, using the ECMAScript set — not Go's unicode.IsSpace.
// The two disagree in both directions (JS trims U+FEFF and Go does not; Go trims U+0085 and JS does
// not), so the set is spelled out here. It is the SAME set internal/report uses for `.trim()`; the
// constant is duplicated rather than exported because a single unexported constant is not worth
// widening that package's API, and a test asserts the two agree on every code point.
func parseJSInt(value string) int {
	trimmed := strings.TrimLeft(value, ecmaWhitespace)

	i := 0
	negative := false
	if i < len(trimmed) && (trimmed[i] == '+' || trimmed[i] == '-') {
		negative = trimmed[i] == '-'
		i++
	}

	start := i
	for i < len(trimmed) && trimmed[i] >= '0' && trimmed[i] <= '9' {
		i++
	}
	if i == start {
		// No digits: NaN, which the caller's repair turns into 0.
		return 0
	}

	n := 0
	for _, c := range trimmed[start:i] {
		// Saturate rather than wrap: a segment long enough to overflow is not a version part, and
		// the JavaScript result for it would be a float beyond exact integer range.
		if n > (1<<62)/10 {
			n = 1 << 62
			break
		}
		n = n*10 + int(c-'0')
	}
	if negative {
		return -n
	}
	return n
}

// ReadIndexedAPIVersions mirrors readIndexedApiVersions: every version in the index, newest first.
//
// ★ TWO ORDERINGS, AND THE SECOND IS THE ONE THAT COUNTS. SQL orders by `version` as TEXT, then Go
// re-sorts NUMERICALLY descending. The textual sort is not cosmetic — it decides what
// `availableVersions[0]` means before the real sort runs — but it is fully overridden, so the
// result depends only on CompareAPIVersions. A port that kept the SQL order and skipped the second
// sort would return a lexicographic "newest", where "1.9.0" sorts after "1.10.0".
func ReadIndexedAPIVersions(db *sql.DB) ([]string, error) {
	if !hasTable(db, "bannerlord_api_versions") {
		return []string{}, nil
	}

	rows, err := db.Query(`SELECT version FROM bannerlord_api_versions ORDER BY version`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	versions := make([]string, 0, 16)
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Stable, so entries the numeric comparison cannot separate keep the SQL order.
	sort.SliceStable(versions, func(i, j int) bool {
		return CompareAPIVersions(versions[j], versions[i]) < 0
	})
	return versions, nil
}

// ResolveVersion mirrors resolveBannerlordApiVersion.
//
// ★ FOUR OUTCOMES, AND THE DIFFERENCE BETWEEN THEM IS THE POINT:
//
//  1. NOTHING INDEXED — no selection, `historical_reference_only`, and a warning naming the indexing
//     command. The caller renders a report with no matches rather than an error.
//  2. A VERSION WAS REQUESTED — selected only on an EXACT string match against the indexed list,
//     after normalisation. An unindexed request yields NO selection (and the caller's early return),
//     not a fallback to the newest.
//  3. NOTHING REQUESTED, INSTALLED VERSION INDEXED — that version, and the only case that carries
//     `official_api_reference` authority.
//  4. NOTHING REQUESTED, INSTALLED VERSION UNKNOWN OR ABSENT — the NEWEST indexed version, with the
//     authority of local source and a warning.
//
// ★ `authority` AND `usage` ARE DERIVED FROM THE SAME CONDITION AS `exactMatch`, and they are not
// independent: in the requested branch they test the same three-part equality; in the default
// branch they key off the INSTALLED-match, not off the selection. So a fallback to the newest
// version is `local_decompiled_source` / `historical_reference_only`, while a requested version that
// equals the installed one is described as authoritative even though the request was explicit.
func ResolveVersion(db *sql.DB, state GameState, requestedVersion string) (VersionResolution, error) {
	availableVersions, err := ReadIndexedAPIVersions(db)
	if err != nil {
		return VersionResolution{}, err
	}

	normalizedRequested := NormalizeAPIVersion(requestedVersion)
	installedGameVersion := state.GameVersion
	installedFullVersion := state.FullVersion
	// ★ INSTALLED VERSION FALLS BACK TO THE FULL ONE *BEFORE* NORMALISING: `a || b`, then parse. So
	// a present-but-unparseable gameVersion does NOT fall through to fullVersion — it normalises to
	// "" and the fallback is never consulted. That ordering is the original's.
	installedSource := installedGameVersion
	if installedSource == "" {
		installedSource = installedFullVersion
	}
	normalizedInstalled := NormalizeAPIVersion(installedSource)

	resolution := VersionResolution{
		InstalledGameVersion: installedGameVersion,
		InstalledFullVersion: installedFullVersion,
		RequestedAPIVersion:  normalizedRequested,
		AvailableVersions:    availableVersions,
	}

	if len(availableVersions) == 0 {
		resolution.Authority = "local_decompiled_source"
		resolution.Usage = "historical_reference_only"
		resolution.Warning = "Official API index is missing. Run bun run index:api-docs first."
		resolution.HasWarning = true
		return resolution, nil
	}

	if normalizedRequested != "" {
		selected := ""
		for _, version := range availableVersions {
			if version == normalizedRequested {
				selected = version
				break
			}
		}
		isExact := selected != "" && normalizedInstalled != "" && selected == normalizedInstalled

		resolution.SelectedAPIVersion = selected
		resolution.HasSelection = selected != ""
		resolution.ExactMatch = isExact
		if isExact {
			resolution.Authority = "official_api_reference"
			resolution.Usage = "reference"
		} else {
			resolution.Authority = "local_decompiled_source"
			resolution.Usage = "historical_reference_only"
		}
		if selected != "" {
			resolution.Warning, resolution.HasWarning = buildVersionWarning(normalizedInstalled, selected)
		} else {
			resolution.Warning = "Requested official API version " + normalizedRequested + " is not indexed."
			resolution.HasWarning = true
		}
		return resolution, nil
	}

	exactInstalled := ""
	if normalizedInstalled != "" {
		for _, version := range availableVersions {
			if version == normalizedInstalled {
				exactInstalled = version
				break
			}
		}
	}
	selected := exactInstalled
	if selected == "" {
		selected = availableVersions[0]
	}

	resolution.SelectedAPIVersion = selected
	resolution.HasSelection = true
	resolution.ExactMatch = exactInstalled != ""
	if exactInstalled != "" {
		resolution.Authority = "official_api_reference"
		resolution.Usage = "reference"
	} else {
		resolution.Authority = "local_decompiled_source"
		resolution.Usage = "historical_reference_only"
		resolution.Warning, resolution.HasWarning = buildVersionWarning(normalizedInstalled, selected)
	}
	return resolution, nil
}

// GameState is the subset of the setup state this package reads.
type GameState struct {
	GameVersion string
	FullVersion string
}

// buildVersionWarning mirrors buildVersionWarning.
//
// ★ IT RETURNS "no warning" FOR TWO DIFFERENT REASONS — no selection at all, and an exact match —
// and the caller cannot tell them apart from the value. That is the original's contract: both
// become the literal "(none)" in the report.
func buildVersionWarning(installedVersion, selectedAPIVersion string) (string, bool) {
	if selectedAPIVersion == "" {
		return "", false
	}
	if installedVersion == "" {
		return "Installed game version is unknown; official API " + selectedAPIVersion + " is reference-only.", true
	}
	if installedVersion == selectedAPIVersion {
		return "", false
	}
	return "Installed game version " + installedVersion + " does not match official API " + selectedAPIVersion +
		"; use local decompiled source as authority.", true
}

// hasTable mirrors the module-private hasTable from src/utils/bannerlord-api-docs.ts, which searches
// for `type IN ('table', 'virtual')`.
//
// ★ IT IS NOT THE SAME PREDICATE AS db.ts's databaseHasTable, which filters `type = 'table'` only —
// but MEASURED on this sqlite, the difference cannot be observed: an FTS5 table is listed in
// sqlite_master with type = 'table' (checked in a synthetic database and in the real index, where
// the only types present are 'table' and 'index'). The wider spelling is preserved because it is
// what the source says, and the note exists so that nobody "simplifies" it later believing the two
// forms are interchangeable in principle — they are only equivalent on this build.
func hasTable(db *sql.DB, tableName string) bool {
	row := db.QueryRow(`SELECT name FROM sqlite_master WHERE type IN ('table', 'virtual') AND name = ?`, tableName)
	var name string
	if err := row.Scan(&name); err != nil {
		return false
	}
	return name != ""
}
