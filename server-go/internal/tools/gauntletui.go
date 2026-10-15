package tools

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"blore/internal/env"
	"blore/internal/report"
	"blore/internal/runtimerev"
	"blore/internal/sandbox"
	"blore/internal/textfilecache"
)

// ReadGauntletUI mirrors readGauntletUi(sandbox, uiFileName) from
// src/tools/read-gauntlet-ui.ts and returns the rendered report text.
//
// The tool is a ViewModel binding checklist for a Gauntlet UI XML: it resolves a UI file
// stem to a path under the sandbox, then lists the DataSource values and Command.Click
// handlers found in it.
//
// ★ THE THREE RETURN PATHS RENDER DIFFERENT queryValue VALUES. Downstream agents parse this
// text, so the difference is part of the contract:
//
//	blank input -> queryValue is the RAW uiFileName, UNTRIMMED, plus error='ui_file_name is required'
//	not found   -> queryValue is the TRIMMED query, plus found=false
//	found       -> queryValue is the TRIMMED query, plus found=true
//
// So `read_gauntlet_ui("  InventoryScreen  ")` echoes the padded string in the error case
// and the trimmed one in the other two. Found/not-found pass a BOOLEAN and are built with
// report.Bool; the error's is a string.
//
// ★ CACHING IS REAL OBSERVABLE BEHAVIOUR, NOT AN OPTIMISATION: both caches memoize MISSES
// (a nil entry in uiPathCache) and are cleared ONLY by the runtime-revision invalidator.
// A second call in the same process, after the file was created or deleted and without the
// revision changing, returns the STALE answer. Runs under test must therefore clear the
// caches explicitly between cases.
func ReadGauntletUI(box *sandbox.Sandbox, uiFileName string) (string, error) {
	// Mirrors the bare `ensureRuntimeRevisionFresh()` at the top of the TypeScript body.
	//
	// ★ NOTE WHICH REVISION IS WATCHED. The TypeScript call passes no game id, and
	// runtime-revision.ts normalises an absent id to 'bannerlord' BEFORE getGamePaths sees
	// it — so the default game's Version.txt is read, not the active game's, even when
	// BANNERSAGE_GAME is set. That is what the original does; it is mirrored, not fixed.
	runtimerev.EnsureFresh(env.GetGamePaths(env.DefaultGameID).VersionPath)

	normalizedQuery := report.TrimJS(uiFileName)
	if normalizedQuery == "" {
		return report.Render("gauntlet_ui", "ui_file_name", uiFileName, nil, []report.Field{
			{Key: "error", Value: report.Text("ui_file_name is required")},
		}), nil
	}

	foundPath, err := resolveUIPath(box, normalizedQuery)
	if err != nil {
		// Mirrors the TypeScript's uncaught rejection from buildUiIndex/getUiIndex.
		return "", err
	}
	if foundPath == "" {
		return report.Render("gauntlet_ui", "ui_file_name", normalizedQuery, nil, []report.Field{
			{Key: "found", Value: report.Bool(false)},
		}), nil
	}

	fullPath, err := box.ValidateAndResolve(foundPath)
	if err != nil {
		// The TypeScript does not catch here, so the tool rejects. The message is the
		// sandbox's own, verbatim. Unreachable today: foundPath comes from a walk of the
		// base path, so it cannot escape it.
		return "", err
	}

	lines, err := textfilecache.ReadLines(fullPath)
	if err != nil {
		// The TypeScript would reject with the fs error from stat/readFile. The message
		// text is therefore NOT identical; the error/no-error distinction is.
		return "", err
	}

	// ★ join('\n') IS NOT A NO-OP. Lines come from a split on /\r?\n/, so joining them
	// back with a single '\n' converts every CRLF to LF and leaves a LONE CR inside a line
	// untouched (a bare CR is not a separator). Byte-comparing the joined text against the
	// raw file would differ on any file with CRLF endings, and the regexes below then see
	// the normalized text — which is what the original does.
	content := strings.Join(lines, "\n")

	dataSources := collectMatches(content, dataSourceRe)
	clickCommands := collectMatches(content, clickCommandRe)

	blocks := []report.Block{{
		Fields: []report.Field{
			{Key: "file_path", Value: report.Text(foundPath)},
			{Key: "file_name", Value: report.Text(baseName(foundPath))},
			{Key: "data_source_count", Value: report.Number(float64(len(dataSources)))},
			{Key: "click_command_count", Value: report.Number(float64(len(clickCommands)))},
		},
		ListFields: []report.ListField{
			{Key: "data_sources", Values: textScalars(dataSources)},
			{Key: "click_commands", Values: textScalars(clickCommands)},
		},
	}}

	return report.Render("gauntlet_ui", "ui_file_name", normalizedQuery, blocks, []report.Field{
		{Key: "found", Value: report.Bool(true)},
	}), nil
}

// dataSourceRe mirrors /DataSource="{([^}]+)}"/g.
//
// ★ THE ANCHORS ARE ASYMMETRIC AND THAT IS THE POINT. A literal `}` must follow, and the
// capture is one-or-more of "not }" — so `DataSource="{}"` does NOT match at all, while
// `DataSource="{ A }"` matches and captures " A ". The trailing `"` is INSIDE the pattern,
// so the attribute must be exactly closed. Go's regexp has no backreferences but needs
// none here; it does need `(?s)`-free `.` semantics, which this pattern does not use.
var dataSourceRe = regexp.MustCompile(`DataSource="{([^}]+)}"`)

// clickCommandRe mirrors /Command\.Click="([^"]+)"/g.
//
// ★ `[^"]+` INCLUDES NEWLINES, so a value that spans a line break is captured whole — and
// because `content` has had CRLF normalized to LF, the captured text carries a bare LF.
// The same one-or-more means `Command.Click=""` is not a match, so an empty handler never
// contributes to the count.
var clickCommandRe = regexp.MustCompile(`Command\.Click="([^"]+)"`)

// collectMatches mirrors collectMatches(content, regex).
//
// ★ THE DEDUPE IS INSERTION-ORDERED (a Set in the original) and each value is TRIMMED
// BEFORE the dedupe, with the TRIMMED value kept. Both halves matter:
//
//	"{ A }" and "{A}"   -> one entry, "A"      (they collide only because of the trim)
//	"{A}" appears twice -> one entry           (the Set)
//	"{   }"             -> no entry            (the trim empties it, and empty is skipped)
//
// So the count in the report is a count of DISTINCT trimmed values, not of matches.
// The original also uses a global regex with exec() in a loop; the Set is what makes the
// result deterministic, not the iteration order, so the Go scan needs no lastIndex care.
func collectMatches(content string, re *regexp.Regexp) []string {
	matches := re.FindAllStringSubmatch(content, -1)
	values := make([]string, 0, len(matches))
	seen := map[string]struct{}{}
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		value := report.TrimJS(match[1])
		if value == "" {
			continue
		}
		if _, dup := seen[value]; dup {
			continue
		}
		seen[value] = struct{}{}
		values = append(values, value)
	}
	return values
}

// textScalars wraps collected strings as report scalars.
func textScalars(values []string) []report.Scalar {
	out := make([]report.Scalar, 0, len(values))
	for _, value := range values {
		out = append(out, report.Text(value))
	}
	return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Module caches

var (
	uiCacheMu sync.Mutex
	// uiPathCache mirrors uiPathCache: key `${box.BasePath()}::<trimmed+lowercased query>`.
	// ★ An EMPTY value is a MEMOIZED MISS, not an absent entry — that is why the lookup is a
	// two-value map access rather than a comparison against "".
	uiPathCache = map[string]string{}
	// uiIndexCache mirrors uiIndexCache: the raw walk result per base path, NOT sorted or
	// filtered. The original stores a Promise, which also memoizes the in-flight walk AND
	// its rejection; the struct below keeps the error for the same reason.
	uiIndexCache = map[string]uiIndexEntry{}
)

// uiIndexEntry is one cached getUiIndex outcome. The TypeScript stores a promise, whose
// rejected state is cached as faithfully as its fulfilled one.
type uiIndexEntry struct {
	index []string
	err   error
}

// clearGauntletUICaches mirrors clearGauntletUiCaches.
func clearGauntletUICaches() {
	uiCacheMu.Lock()
	uiPathCache = map[string]string{}
	uiIndexCache = map[string]uiIndexEntry{}
	uiCacheMu.Unlock()
}

func init() {
	// Mirrors the registerRuntimeInvalidator call at the bottom of read-gauntlet-ui.ts.
	runtimerev.RegisterInvalidator(clearGauntletUICaches)
}

// resolveUIPath mirrors resolveUiPath(sandbox, uiFileName).
//
// ★ QUERY AND CACHE KEY ARE DIFFERENT STRINGS BY CONSTRUCTION. The key lowercases the
// query; the lookup compares `getXmlStem(path)` (already lowercased inside) against the
// lowercased query. Both are lowercased, so the comparison is case-insensitive in the
// ASCII sense.
//
// ★ THE EXACT/PREFIX FALLBACK IS NOT A "BEST MATCH". If ANY candidate's stem equals the
// query exactly, the prefix candidates are IGNORED ENTIRELY — so 'setx' does NOT reach
// 'SetAlpha.xml' when 'Setx.xml' also exists, and a query that exactly names a
// low-scoring file (say `foo/bar/Thing.xml`) beats a higher-scoring prefix match (such as
// `GUI/Prefabs/ThingScreen.xml`). The scoring only orders within one of the two sets.
//
// ★ ON A WALK ERROR THE PATH CACHE IS NOT WRITTEN. The original awaits getUiIndex() before
// the `uiPathCache.set` line, so a rejection skips the store entirely — only the
// (rejected) index promise is cached. Mirrored by returning before the store below.
func resolveUIPath(box *sandbox.Sandbox, uiFileName string) (string, error) {
	cacheKey := box.BasePath() + "::" + strings.ToLower(uiFileName)

	uiCacheMu.Lock()
	if cached, ok := uiPathCache[cacheKey]; ok {
		uiCacheMu.Unlock()
		return cached, nil
	}
	uiCacheMu.Unlock()

	candidates, err := getUIIndex(box.BasePath())
	if err != nil {
		return "", err
	}
	normalizedQuery := strings.ToLower(uiFileName)

	exactMatches := make([]string, 0, len(candidates))
	for _, path := range candidates {
		if getXMLStem(path) == normalizedQuery {
			exactMatches = append(exactMatches, path)
		}
	}

	prefixMatches := exactMatches
	if len(exactMatches) == 0 {
		prefixMatches = make([]string, 0, len(candidates))
		for _, path := range candidates {
			if strings.HasPrefix(getXMLStem(path), normalizedQuery) {
				prefixMatches = append(prefixMatches, path)
			}
		}
	}

	bestMatch := ""
	if ranked := rankUIMatches(prefixMatches); len(ranked) > 0 {
		bestMatch = ranked[0]
	}

	uiCacheMu.Lock()
	uiPathCache[cacheKey] = bestMatch
	uiCacheMu.Unlock()
	return bestMatch, nil
}

// getUIIndex mirrors getUiIndex(basePath): one walk per base path, cached forever until an
// invalidator clears it.
//
// ★ THE ERROR IS CACHED AS WELL AS THE RESULT, and that is the original's behaviour rather
// than an oversight in the port. The TypeScript stores the PROMISE (`uiIndexCache.set(basePath,
// pending)`) before awaiting it, so a rejected promise stays in the map and every later call
// awaits the SAME rejection. A Go port that cached only successes would retry the walk on the
// next call and could then succeed — a different answer for the same process.
//
// ★ CONSEQUENCE FOR TESTS AND FOR OPERATIONS: once a walk fails, this base path keeps failing
// until the runtime revision invalidator clears the caches. On the failure path there is no
// revision change to trigger it, so in practice it fails for the life of the process.
func getUIIndex(basePath string) ([]string, error) {
	uiCacheMu.Lock()
	defer uiCacheMu.Unlock()
	if cached, ok := uiIndexCache[basePath]; ok {
		return cached.index, cached.err
	}
	index, err := buildUIIndex(basePath)
	uiIndexCache[basePath] = uiIndexEntry{index: index, err: err}
	return index, err
}

// buildUIIndex mirrors buildUiIndex(basePath), which scans `new Glob('**/*.xml')` with
// `cwd: basePath` and stores `relativePath.replaceAll('\', '/')`.
//
// ★ THE WALK IS A HAND-ROLLED ONE BECAUSE THE GLOB'S MEMBERSHIP RULES WERE MEASURED RATHER
// THAN ASSUMED (bun 1.4.3, Windows; raw output recorded in the port report):
//
//	membership OF A FILE requires: an extension of EXACTLY the lowercase ".xml" (".XML",
//	  ".Xml", ".xMl" and a trailing space all yield nothing — the glob is not case-insensitive
//	  here, even on a case-insensitive filesystem);
//	directories' names are irrelevant, INCLUDING a directory named a.xml — its CONTENTS are
//	  scanned, and the directory itself is never emitted as a match;
//	any path segment beginning with "." is skipped ENTIRELY: a dot-prefixed file, and
//	  everything below a dot-prefixed directory, invisible;
//	a Windows JUNCTION is NOT descended into and NOT emitted, even when its own name ends in
//	  ".xml" — bun reports it as a symlink, and so does Go, but as `ModeIrregular` with
//	  `IsDir() == false` rather than as `ModeSymlink` (measured, Go 1.27);
//	the Windows HIDDEN ATTRIBUTE is IRRELEVANT — a file whose name has no dot is returned
//	  even with +H set, and a dot-named file is skipped even without +H.
//
// The walk is hand-rolled rather than a `filepath.WalkDir` for one reason: WalkDir visits
// every entry and reports the DIRECTORIES it declines to enter through its error callback,
// which is the wrong shape for "emit only members". Two filters do the work here — the dot
// filter and `Type().IsRegular()` — and neither needs an IsDir special case for junctions,
// because a junction is not a directory as far as a dirent is concerned.
//
// ★ SCAN ORDER IS NOT MIRRORED, and cannot be: bun returns a depth-first order whose
// children come out in the order the OS happens to enumerate them (measured: reverse NAME
// order on this machine for 40 freshly created siblings — stable across repeated runs, but
// undocumented and host-dependent). Order is unobservable through this tool whenever the
// ranking has a unique winner — rankUIMatches sorts fully and the winner is element 0 — but
// it IS observable when two candidates score identically, which is why the tie-break below
// matters. os.ReadDir sorts lexically, so the tie outcome here is deterministic where the
// original's depends on the filesystem.
func buildUIIndex(basePath string) ([]string, error) {
	results := []string{}
	if err := walkXML(basePath, "", &results); err != nil {
		// ★ MEASURED, AND THE OPPOSITE OF WHAT "skip a bad directory" WOULD GUESS: bun's
		// scan THROWS when a directory cannot be listed (EPERM for a permission-denied
		// subdirectory, ENOENT for a missing cwd, ENOTDIR when cwd is a file), and the
		// TypeScript's `for await` therefore rejects `buildUiIndex` and the tool call with
		// it. Any partial results collected so far are discarded.
		//
		// ★ The message TEXT is not mirrored: the original surfaces Node's errno string
		// ("EPERM: operation not permitted, open '<dir>'") while Go's os.ReadDir returns a
		// *PathError. The error/no-error distinction — which is what a caller observes — is
		// preserved.
		return nil, err
	}
	return results, nil
}

// walkXML is the recursive half of buildUIIndex. rel is the forward-slash relative path
// built so far ("" at the root), which keeps the stored value OS-independent and matches
// `replaceAll('\\', '/')` without ever producing a backslash.
//
// A listing failure is RETURNED, not skipped: see buildUIIndex. Note the walk stops at the
// FIRST such failure, matching the generator, which stops where it throws.
func walkXML(dir, rel string, results *[]string) error {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}

	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			// Measured: dot-prefixed files and directories are invisible, at any depth.
			continue
		}

		childRel := name
		if rel != "" {
			childRel = rel + "/" + name
		}

		// ★ Does NOT follow symlinks/junctions, which is the measured behaviour.
		//
		// The test is on the dirent TYPE BITS, not on ModeSymlink alone: measured with Go
		// 1.27 on this host, a Windows JUNCTION reports `ModeIrregular` (0x80000) and
		// `IsDir() == false`, NOT `ModeSymlink`. A symlink-only test would therefore walk
		// past the junction and, when the junction is named `*.xml`, EMIT it as a file —
		// which bun does not do. Requiring a regular file covers both encodings, so a
		// future Go that reports junctions as symlinks cannot reintroduce the divergence.
		if entry.IsDir() {
			if err := walkXML(filepath.Join(dir, name), childRel, results); err != nil {
				return err
			}
			continue
		}
		if !entry.Type().IsRegular() {
			continue
		}
		if !strings.HasSuffix(name, ".xml") {
			// Case-sensitive on purpose: ".XML" is NOT a member (measured).
			continue
		}
		*results = append(*results, childRel)
	}
	return nil
}

// rankUIMatches mirrors rankUiMatches(paths): score DESC, ties broken by
// `left.localeCompare(right)`.
//
// ★ THE TIE-BREAK IS A DECLARED DEVIATION — see the measurement below.
//
// localeCompare uses the HOST locale. On this machine `new Intl.Collator().resolvedOptions().locale`
// is "zh-CN", and the collation it produces disagrees with a UTF-16 code-unit comparison on 22
// of 40 crafted pairs, including the commonest shapes in a UI file list:
//
//	"Apple.xml" vs "apple.xml"      localeCompare=1   codeUnit=-1
//	"a-gui"     vs "a_gui"          localeCompare=1   codeUnit=-1   (ICU puts '_' BEFORE '-', code units do the reverse)
//	"item2.xml" vs "item10.xml"     agree
//	"café.xml"  vs "cafe.xml"       localeCompare=-1  codeUnit=1
//	"café.xml"  vs "cafe\u0301.xml" localeCompare=0   codeUnit=1    (canonically EQUAL, not merely close)
//	"界面.xml"  vs "abc.xml"        localeCompare=-1  codeUnit=1
//
// So the original's own ordering is machine-dependent — the same two paths can come back in
// either order on two hosts — and reproducing it would mean depending on ICU collation data
// Go's standard library does not ship, or on an OS collator that would re-import the same
// host dependence. The project's precedent for exactly this situation is
// report.FilePathCompare: use code-unit order and say so. This tie-break is therefore
// code-unit order (report.CompareCodeUnits), and the consequence, stated plainly: when two
// candidates share a score and their paths differ only in case, punctuation or accent, the
// candidate chosen here may differ from the one the TypeScript chose.
//
// ★ TWO FURTHER PROPERTIES OF THE ORIGINAL, both mirrored rather than smoothed:
//   - the sort is `[...paths].sort(...)`, i.e. STABLE. Measured: with twelve canonically
//     equivalent pairs interleaved, the original's output preserved the input interleaving
//     (0101...), so equal-comparing paths keep their discovery order. sort.SliceStable below
//     does the same.
//   - localeCompare reports EQUAL (0) for strings that are NOT equal — measured on the NFC
//     and NFD spellings of the same accented path, which collate as one key. The code-unit
//     comparator never returns 0 for those, so it may order them where the original would
//     have left them in discovery order.
func rankUIMatches(paths []string) []string {
	ranked := make([]string, len(paths))
	copy(ranked, paths)
	sort.SliceStable(ranked, func(i, j int) bool {
		left, right := ranked[i], ranked[j]
		scoreDelta := getUIMatchScore(right) - getUIMatchScore(left)
		if scoreDelta != 0 {
			return scoreDelta < 0
		}
		return report.CompareCodeUnits(left, right) < 0
	})
	return ranked
}

// getUIMatchScore mirrors getUiMatchScore(path).
//
// The checks are ORDERED and mutually exclusive: the score is the FIRST match, so a path
// under `/gui/prefabs/` scores 30 even though it also contains `/gui/` and `/prefabs/`.
// A path containing `/prefabs/` but not `/gui/` scores 10. The comparison is on the
// LOWERCASED path, and the needles include both slashes, so the score depends on the
// separator being '/' — which holds because buildUIIndex normalized it.
func getUIMatchScore(path string) int {
	normalized := strings.ToLower(path)
	if strings.Contains(normalized, "/gui/prefabs/") {
		return 30
	}
	if strings.Contains(normalized, "/gui/") {
		return 20
	}
	if strings.Contains(normalized, "/prefabs/") {
		return 10
	}
	return 0
}

// getXMLStem mirrors getXmlStem(path): basename, LOWERCASED, then a trailing '.xml'
// stripped. The '.xml' test is on the lowercased name, so 'InventoryScreen.XML' yields
// 'inventoryscreen' — a stem that can only be reached through this function, never from
// the walk (which is case-sensitive and would not have listed the file at all).
func getXMLStem(path string) string {
	fileName := strings.ToLower(baseName(path))
	if strings.HasSuffix(fileName, ".xml") {
		return fileName[:len(fileName)-4]
	}
	return fileName
}

// baseName mirrors node:path basename, which is what the TypeScript imports.
//
// ★ NOT filepath.Base. On Windows the walk hands back forward-slash relative paths, and
// filepath.Base treats only the OS separator as a separator — so `filepath.Base("a/b/c.xml")`
// on Windows returns the WHOLE string "a/b/c.xml", not "c.xml". (Linux and Windows would
// also disagree with each other, which is why this is hand-rolled rather than left to
// filepath.) Both separators are handled here so the function is correct for a backslash
// path too, matching Node's win32 basename.
//
// Trailing separators are stripped first, so "a.xml/" -> "a.xml", exactly as Node does.
func baseName(path string) string {
	end := len(path)
	for end > 0 && (path[end-1] == '/' || path[end-1] == '\\') {
		end--
	}
	path = path[:end]
	for i := end - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[i+1:]
		}
	}
	return path
}
