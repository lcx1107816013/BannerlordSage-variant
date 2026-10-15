// Package owndocs ports src/utils/own-docs.ts: it walks the in-repo `knowledge/` tree (plus any
// extra directories named by an environment variable) and splits each markdown file into the
// per-section rows that search_docs indexes and returns.
//
// ★ IT IS THE WRITE SIDE OF search_docs. The url it builds (`knowledge://<path>#<slug>`) is what a
// search result displays, and the row id is the SHA-1 of `source|url`, so a port that changed
// either would make previously indexed rows unreachable rather than visibly wrong.
package owndocs

import (
	"os"
	"path/filepath"
	"strings"
	"unicode/utf16"

	"blore/internal/docsdb"
	"blore/internal/report"
)

// Source mirrors OWN_DOCS_SOURCE.
type Source struct {
	ID       string
	Label    string
	BaseURL  string
	Language string
}

// OwnDocsSource mirrors OWN_DOCS_SOURCE.
var OwnDocsSource = Source{
	ID:       "own_knowledge",
	Label:    "Own Knowledge Base (in-repo knowledge/ + configured dirs)",
	BaseURL:  "knowledge/",
	Language: "zh-en",
}

// KnowledgeRoot mirrors knowledgeRoot, which joins the repo root with "knowledge".
//
// The caller supplies the root: the TypeScript reads a module constant computed from
// `import.meta.dir`, which the Go side does not have — and taking it as an argument is also what
// lets the differential point it at a fixture tree.
func KnowledgeRoot(root string) string {
	return filepath.Join(root, "knowledge")
}

// ListOwnDocDirs mirrors listOwnDocDirs.
//
// ★ THE EXTRA DIRECTORIES COME FROM AN ENVIRONMENT VARIABLE, split on `;` OR `|`, and each entry is
// TRIMMED then RESOLVED against the process's working directory. So a relative entry means "relative
// to where the server was started", not "relative to the repo" — a difference a user would notice
// only when launching from elsewhere.
//
// ★ NON-DIRECTORIES ARE DROPPED, silently: a configured path that does not exist, or that is a
// file, simply does not appear in the result. There is no error and no warning, so a typo reduces
// the indexed corpus without any signal.
//
// ★ THE KNOWLEDGE ROOT IS CHECKED THE SAME WAY and can therefore be absent from the result too.
//
// The trim is JavaScript's, from internal/report (one implementation of the measured ECMAScript set,
// not two).
func ListOwnDocDirs(root string, lookupEnv func(string) (string, bool)) []string {
	dirs := []string{KnowledgeRoot(root)}

	if extra, ok := lookupEnv("BANNERSAGE_OWN_DOCS_DIRS"); ok {
		if trimmed := report.TrimJS(extra); trimmed != "" {
			for _, part := range splitOnSemicolonOrPipe(trimmed) {
				if resolved := report.TrimJS(part); resolved != "" {
					// `resolve` makes the entry ABSOLUTE against the working directory.
					if abs, err := filepath.Abs(resolved); err == nil {
						dirs = append(dirs, abs)
					} else {
						dirs = append(dirs, resolved)
					}
				}
			}
		}
	}

	out := make([]string, 0, len(dirs))
	for _, dir := range dirs {
		if isDirectory(dir) {
			out = append(out, dir)
		}
	}
	return out
}

// splitOnSemicolonOrPipe mirrors `extra.split(/[;|]/)`.
//
// ★ IT IS A CHARACTER CLASS, so a run of separators produces EMPTY entries rather than being
// collapsed — `"a;;b"` splits into three parts, the middle one empty, and the emptiness is then
// filtered by the trim test above. Splitting on the literal string ";" only would keep the empty
// entry, and splitting on a whitespace-trimmed form would drop `a|b` entirely for a Windows path
// containing neither.
func splitOnSemicolonOrPipe(value string) []string {
	return strings.FieldsFunc(value, func(r rune) bool { return r == ';' || r == '|' })
}

func isDirectory(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// ListOwnDocFiles mirrors listOwnDocFiles. The result is SORTED, and the sort is JavaScript's
// default (UTF-16 code-unit order) — see the note in the comparator below.
//
// ★ THE WALK APPENDS THROUGH A POINTER, AND THAT IS A FIX, NOT A STYLE CHOICE. The first version
// took `out []string` and appended to it: appends beyond the caller's length rebind the local
// header, so the caller's slice never grew and this function returned ZERO FILES on a tree full of
// them. The differential caught it (the walk corpus compared 0 against 11), which is the kind of
// defect that a unit test asserting "no error" would have passed.
func ListOwnDocFiles(dirs []string) []string {
	files := make([]string, 0, 64)
	seen := map[string]struct{}{}
	for _, dir := range dirs {
		walkMarkdown(dir, &files, seen)
	}
	sortCodeUnits(files)
	return files
}

// walkMarkdown mirrors walkMarkdown.
//
// ★ A READ ERROR IS SILENT. `readdirSync` is wrapped in a try/catch that RETURNS, so an unreadable
// subdirectory contributes nothing and the walk continues elsewhere. Reproduced rather than
// reported: a caller that wants to know would have to stat first.
//
// ★ DOT-NAMES ARE SKIPPED BEFORE THE DIRECTORY TEST, so a HIDDEN DIRECTORY IS NEVER ENTERED. That
// includes `.git` and every dot-directory a user might have put notes in.
//
// ★ IT FOLLOWS NO SYMLINKS — not because it special-cases them, but because `entry.isDirectory()` is
// false for a symlink dirent and `entry.isFile()` is false for a symlinked file. So a symlinked
// markdown file is skipped and a symlinked directory is never entered. This is the opposite of
// internal/runtimecheck's walker, whose source DOES follow links; the two are not inconsistent, they
// mirror two different originals.
//
// ★ THE SEEN KEY IS `resolve(full).toLowerCase()`, so two paths that differ only in CASE are the
// same file. Reproduced with a lowercase fold of the absolute path, because that is the observable
// part of the dedupe.
func walkMarkdown(dir string, out *[]string, seen map[string]struct{}) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		full := filepath.Join(dir, name)
		if entry.IsDir() {
			walkMarkdown(full, out, seen)
			continue
		}
		// `entry.isFile()` is false for anything that is not a regular file — a symlink, a socket,
		// a device — so requiring a regular file reproduces the original's two conditions at once.
		if !entry.Type().IsRegular() {
			continue
		}
		if !hasMarkdownExtension(name) {
			continue
		}
		key := strings.ToLower(resolvedPath(full))
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		*out = append(*out, full)
	}
}

// hasMarkdownExtension mirrors `/\.md$/i`: a CASE-INSENSITIVE suffix test.
func hasMarkdownExtension(name string) bool {
	return len(name) >= 3 && strings.EqualFold(name[len(name)-3:], ".md")
}

func resolvedPath(path string) string {
	if abs, err := filepath.Abs(path); err == nil {
		return abs
	}
	return path
}

// MarkdownSection mirrors MarkdownSection.
type MarkdownSection struct {
	Slug    string
	Heading string
	Content string
}

// SplitMarkdownIntoSections mirrors splitMarkdownIntoSections.
//
// ★ THE HEADING REGEX IS NOT MULTILINE — it is applied per LINE, after the text is split. So
// `^##\s+(.+?)\s*$` anchors to the whole line either way, and the effect is the same. What is NOT
// the same is the lazy group with a trailing `\s*`: `## a  b ` yields the heading `a  b` with only
// the TRAILING whitespace removed and the interior spaces kept.
//
// ★ TEXT BEFORE THE FIRST `##` BECOMES ONE SECTION with the slug `intro`, and it is emitted even
// with an EMPTY heading. The flush condition is `heading || content`, so a document that is entirely
// blank produces NO sections while one with only frontmatter produces one with empty content — see
// the generator's corpus, which pins both.
func SplitMarkdownIntoSections(markdown string) []MarkdownSection {
	text := strings.ReplaceAll(StripFrontmatter(markdown), "\r\n", "\n")
	lines := strings.Split(text, "\n")

	sections := make([]MarkdownSection, 0, 8)
	currentHeading := ""
	currentSlug := "intro"
	buffer := make([]string, 0, 32)

	flush := func() {
		content := strings.TrimSpace(report.TrimJS(strings.Join(buffer, "\n")))
		if currentHeading != "" || content != "" {
			sections = append(sections, MarkdownSection{Slug: currentSlug, Heading: currentHeading, Content: content})
		}
	}

	for _, line := range lines {
		if heading, ok := matchH2(line); ok {
			flush()
			currentHeading = heading
			currentSlug = Slugify(heading)
			buffer = buffer[:0]
			continue
		}
		buffer = append(buffer, line)
	}
	flush()

	return sections
}

// matchH2 mirrors `/^##\s+(.+?)\s*$/`.
//
// ★ EXACTLY TWO HASHES: `###` does not match, because the third character is a hash rather than
// whitespace. And at least one whitespace character is REQUIRED, so `##heading` is body text.
//
// ★ A LINE OF JUST HASHES AND SPACES DOES NOT MATCH, because the lazy `(.+?)` needs at least one
// character that the trailing `\s*` cannot also consume. So `## ` falls through into the body —
// measured against the TypeScript rather than reasoned about.
//
// The capture is the line with the leading `##` and whitespace removed and the TRAILING whitespace
// removed, with any interior whitespace preserved.
func matchH2(line string) (string, bool) {
	if !strings.HasPrefix(line, "##") {
		return "", false
	}
	rest := line[2:]
	if rest == "" || (rest[0] != ' ' && rest[0] != '\t' && rest[0] != '\n' && rest[0] != '\r' &&
		rest[0] != '\v' && rest[0] != '\f' && !isUnicodeSpace(rest[0])) {
		return "", false
	}
	// `\s+` consumes one or more whitespace characters.
	trimmed := strings.TrimLeftFunc(rest, isJSSpaceRune)
	if trimmed == "" {
		return "", false
	}
	// `(.+?)\s*$`: the capture ends before any trailing whitespace run, and must be non-empty.
	body := strings.TrimRightFunc(trimmed, isJSSpaceRune)
	if body == "" {
		return "", false
	}
	return body, true
}

func isUnicodeSpace(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\v' || b == '\f'
}

// isJSSpaceRune reports whether a rune is in the ECMAScript whitespace set, which is what `\s`
// matches. It is NOT unicode.IsSpace: the two disagree in both directions (JS includes U+FEFF and
// excludes U+0085), and the heading regex uses `\s` on BOTH sides of the capture.
func isJSSpaceRune(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680',
		'\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007',
		'\u2008', '\u2009', '\u200a', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return false
}

// StripFrontmatter mirrors stripFrontmatter.
//
// ★ THREE BEHAVIOURS THAT ONLY SHOW UP ON MALFORMED INPUT, all measured rather than assumed:
//
//  1. A document that does not START with `---` is returned UNCHANGED. The test is on the first
//     three characters, so leading whitespace defeats it.
//  2. An opening `---` with no following `\n---` is returned UNCHANGED — the search starts at
//     index 3, so the opening delimiter itself is never considered.
//  3. An UNTERMINATED block (`---\ntitle: x\n---` with no trailing newline) is also returned
//     UNCHANGED, and the reason is an off-by-one that turns into a no-op: `indexOf('\n', end+1)`
//     returns -1, and `slice(-1 + 1)` is `slice(0)`, the whole string. A port that treated -1 as
//     "empty result" would strip the frontmatter the original keeps.
func StripFrontmatter(markdown string) string {
	if !strings.HasPrefix(markdown, "---") {
		return markdown
	}
	end := strings.Index(markdown[3:], "\n---")
	if end < 0 {
		return markdown
	}
	end += 3 // the search started three bytes in

	newlineAfter := strings.Index(markdown[end+1:], "\n")
	if newlineAfter < 0 {
		// `slice(-1 + 1)` is `slice(0)`: the WHOLE string, including the frontmatter.
		return markdown
	}
	return markdown[end+1+newlineAfter+1:]
}

// Slugify mirrors slugify.
//
// ★ THE ALLOWED SET IS ASCII LOWER, DIGITS, AND `U+4E00..U+9FFF` — the CJK Unified Ideographs block.
// Characters OUTSIDE that range (including CJK extensions, kana, and every accented letter) are
// replaced by a dash, so a heading in Japanese produces `section` rather than a slug.
//
// ★ THE TRUNCATION IS IN UTF-16 CODE UNITS. After the replace, every surviving character is either
// ASCII, a dash, or a CJK ideograph, all of which are ONE unit — so the 80-unit cut cannot split a
// character here. That is why the port can truncate runes; it is stated because it would be wrong
// for a set that admitted supplementary characters.
//
// ★ THE LOWERCASE IS FULL MAPPING, not Go's simple per-rune mapping; policyid's note records the
// one code point where they differ (U+0130) and the same helper is used here rather than a second
// implementation.
func Slugify(value string) string {
	lowered := lowerFullUnicode(value)

	var b strings.Builder
	b.Grow(len(lowered))
	lastWasDash := false
	for _, r := range lowered {
		if isSlugChar(r) {
			b.WriteRune(r)
			lastWasDash = false
			continue
		}
		// `[^...]+` collapses a RUN of disallowed characters into ONE dash.
		if !lastWasDash {
			b.WriteByte('-')
			lastWasDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	// `.slice(0, 80)` in UTF-16 code units — safe to do in runes here, see the note above.
	slug = sliceCodeUnits(slug, 80)
	if slug == "" {
		return "section"
	}
	return slug
}

func isSlugChar(r rune) bool {
	if r >= 'a' && r <= 'z' {
		return true
	}
	if r >= '0' && r <= '9' {
		return true
	}
	return r >= 0x4e00 && r <= 0x9fff
}

// sliceCodeUnits truncates a string to n UTF-16 code units, which is what String.prototype.slice
// does.
func sliceCodeUnits(value string, n int) string {
	units := utf16.Encode([]rune(value))
	if len(units) <= n {
		return value
	}
	return string(utf16.Decode(units[:n]))
}

// lowerFullUnicode is the full Unicode lowercase mapping, differing from Go's simple mapping in
// exactly one code point (U+0130). policyid carries the same helper; it is duplicated here rather
// than exported from there because exporting a case-folding primitive from a package named for
// policy ids would be the wrong home for it — and the shared, measured fact is recorded in both
// places with the same source.
func lowerFullUnicode(value string) string {
	if !strings.ContainsRune(value, '\u0130') {
		return strings.ToLower(value)
	}
	return strings.ToLower(strings.ReplaceAll(value, "\u0130", "i\u0307"))
}

// TitleFromFile mirrors titleFromFile.
//
// ★ THE H1 REGEX IS MULTILINE, unlike the section regex, so it finds the first line that STARTS with
// `# ` — which may be far down the file. `.+?` is lazy and `\s*$` trims the trailing whitespace with
// `/m` making `$` match at a line break. The capture is therefore the first heading line's text.
//
// ★ `#` ALONE DOES NOT MATCH, and neither does `#text` (no space), for the same reason as the `##`
// rule.
//
// ★ THE FALLBACK IS THE FILE PATH RELATIVE TO THE KNOWLEDGE ROOT, with backslashes turned into
// slashes and a trailing `.md` removed CASE-INSENSITIVELY. `relative()` yields a path with the
// PLATFORM separator, which is why the replace exists — on Linux it is a no-op and on Windows it is
// the whole point.
func TitleFromFile(markdown, filePath, knowledgeRoot string) string {
	text := StripFrontmatter(markdown)
	if h1, ok := firstH1(text); ok {
		return h1
	}
	rel, err := filepath.Rel(knowledgeRoot, filePath)
	if err != nil {
		rel = filePath
	}
	slashed := strings.ReplaceAll(rel, "\\", "/")
	if hasMarkdownExtension(slashed) {
		slashed = slashed[:len(slashed)-3]
	}
	return slashed
}

// firstH1 mirrors `/^#\s+(.+?)\s*$/m`.
func firstH1(text string) (string, bool) {
	for _, line := range strings.Split(text, "\n") {
		if !strings.HasPrefix(line, "#") {
			continue
		}
		rest := line[1:]
		if rest == "" || !isJSSpaceRune(rune(rest[0])) {
			continue
		}
		trimmed := strings.TrimLeftFunc(rest, isJSSpaceRune)
		body := strings.TrimRightFunc(trimmed, isJSSpaceRune)
		if body == "" {
			continue
		}
		return body, true
	}
	return "", false
}

// BuildOwnDocRows mirrors buildOwnDocRows.
//
// ★ AN UNREADABLE FILE IS SKIPPED, not reported: `readFileSync` is inside a try/catch that
// continues. The read is UTF-8 and no BOM is stripped here — the XML decoder's BOM handling is a
// different module, and a markdown file beginning with a BOM keeps it, which then defeats the
// `startsWith('---')` frontmatter test.
//
// ★ THE CATEGORY IS THE FIRST PATH SEGMENT UNDER THE KNOWLEDGE ROOT, or the literal `root` when the
// file sits directly in it. So a nested file `knowledge/a/b/c.md` is categorised `a`, and a file
// OUTSIDE the knowledge root (from a configured extra directory) gets a `..`-style relative path
// and therefore a category like `..` — a consequence of the same arithmetic, not a special case.
//
// ★ THE CONTENT IS `heading + "\n" + sectionContent` WITH FALSY PARTS DROPPED, so an
// introduction-only document indexes its text alone while a heading-only section indexes the
// heading alone. A section whose content is empty AND whose heading is empty is skipped entirely.
func BuildOwnDocRows(files []string, indexedAt, knowledgeRoot string) ([]docsdb.DocRow, error) {
	rows := make([]docsdb.DocRow, 0, len(files)*4)
	for _, filePath := range files {
		raw, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}
		markdown := string(raw)

		fileTitle := TitleFromFile(markdown, filePath, knowledgeRoot)
		relativePath := relativeSlashed(knowledgeRoot, filePath)

		category := "root"
		if idx := strings.Index(relativePath, "/"); idx >= 0 {
			category = relativePath[:idx]
		}

		for _, section := range SplitMarkdownIntoSections(markdown) {
			headingSuffix := ""
			if section.Heading != "" {
				headingSuffix = " — " + section.Heading
			}
			content := ""
			if section.Heading != "" {
				content = section.Heading
			}
			if section.Content != "" {
				if content != "" {
					content += "\n"
				}
				content += section.Content
			}
			if content == "" {
				continue
			}
			url := "knowledge://" + relativePath + "#" + section.Slug
			rows = append(rows, docsdb.DocRow{
				ID:        docsdb.MakeDocID(OwnDocsSource.ID, url),
				Source:    OwnDocsSource.ID,
				Language:  OwnDocsSource.Language,
				Category:  category,
				Title:     fileTitle + headingSuffix,
				URL:       url,
				Content:   content,
				IndexedAt: indexedAt,
			})
		}
	}
	return rows, nil
}

func relativeSlashed(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil {
		rel = path
	}
	return strings.ReplaceAll(rel, "\\", "/")
}

// sortCodeUnits sorts like JavaScript's Array.prototype.sort on strings: by UTF-16 code units.
//
// The paths compared are file paths, which can contain non-ASCII; a byte-wise sort orders them the
// same way a code-unit sort does for ASCII, and differs once a path holds characters above the BMP.
// report.CompareCodeUnits exists for exactly this and is called per comparison rather than sorting
// by a byte key.
func sortCodeUnits(values []string) {
	insertionSort(values, func(a, b string) bool {
		return report.CompareCodeUnits(a, b) < 0
	})
}

// insertionSort is a small stable sort; the file lists here are tens of entries, and the port avoids
// pulling in a comparator package for one call site.
func insertionSort(values []string, less func(a, b string) bool) {
	for i := 1; i < len(values); i++ {
		for j := i; j > 0 && less(values[j], values[j-1]); j-- {
			values[j], values[j-1] = values[j-1], values[j]
		}
	}
}
