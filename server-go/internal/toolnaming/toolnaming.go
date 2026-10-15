// Package toolnaming ports src/utils/tool-naming.ts: the Archive tool-name contract.
//
// ★ THE PREFIX IS APPLIED AT THE REGISTRATION SITE, and that placement IS the feature. The rename
// to `ba_*` used to happen in BannerScribe Core's dispatch layer, which meant this server still
// advertised its old names and only the aggregate view looked renamed — a rename with exactly one
// consumer is a translation table, not a rename. The prefix lives here so what the server
// advertises is the contract.
//
// ★ IT IS NOT AN ALIAS LAYER, and that is deliberate: old names are NOT also registered.
// Registering both would make Core expose `ba_doctor` and, after its own pass,
// `ba_bannerlord_doctor` — a doubled prefix. This port therefore returns ONE name, and a caller
// holding an old name has to be updated. Adding a compatibility alias here would reintroduce the
// defect the module exists to prevent.
package toolnaming

import "strings"

// ArchivePrefix mirrors ARCHIVE_PREFIX.
const ArchivePrefix = "ba_"

// LegacyPrefixes mirrors LEGACY_PREFIXES.
//
// ★ IT IS A LIST, AND ONLY THE FIRST MATCH IS STRIPPED (`break` after the slice). With ONE entry
// today the `break` is UNOBSERVABLE — removing it changes no input, because the loop body can run
// only once. That was MEASURED: a mutation dropping the `break` was not caught by any test, and it
// is an EQUIVALENT change rather than a coverage gap.
//
// It is kept anyway because it becomes load-bearing the moment a second entry is added: two
// entries where the first is a prefix of the second would strip a chain instead of one prefix, and
// that difference would be silent. The loop is therefore in the ported shape, and this note records
// BOTH facts — the mutation result and why the code stays as it is — so nobody later removes the
// `break` to "satisfy a mutation".
var LegacyPrefixes = []string{"bannerlord_"}

// ArchiveToolName mirrors archiveToolName.
//
// ★ THE PREFIX IS STRIPPED ONLY AT THE START. `bannerlord_x` becomes `ba_x`, while `x_bannerlord_y`
// is left alone and becomes `ba_x_bannerlord_y`. A port that used Replace would rewrite every
// occurrence and produce a different name for that input.
//
// ★ A NAME THAT ALREADY CARRIES THE ARCHIVE PREFIX IS NOT SPECIAL-CASED. ArchiveToolName("ba_x")
// is "ba_ba_x" — the function does not detect a double application. That is the original's
// behaviour and it is reachable: a caller that runs the conversion twice gets a doubled prefix,
// which is the same defect the module's comment describes for aliases. Pinned by the corpus rather
// than "fixed".
func ArchiveToolName(legacyName string) string {
	bare := legacyName
	for _, p := range LegacyPrefixes {
		if strings.HasPrefix(bare, p) {
			bare = bare[len(p):]
			break
		}
	}
	return ArchivePrefix + bare
}

// ArchiveTool mirrors archiveTool: the current name and the legacy name together, so registration,
// the toolset lists and the tests agree by construction rather than by three hand-edited strings.
func ArchiveTool(legacyName string) (name, legacy string) {
	return ArchiveToolName(legacyName), legacyName
}
