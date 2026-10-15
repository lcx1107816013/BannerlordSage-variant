package gameprofiles

import (
	"regexp"
	"strings"
)

// The helpers below mirror the module-private functions at the bottom of game-profiles.ts. They
// live in their own file so the classification logic above stays readable.

// moddingRootBinExcludes mirrors BANNERLORD_MODDING_ROOT_BIN_EXCLUDES.
//
// ★ THEY ARE APPLIED TO THE LOWERCASED FILE NAME, and the patterns are anchored with ^ and (where
// it matters) $. The launcher and access-provider patterns use a TRAILING DOT to match a family of
// assemblies, so `taleworlds.platformservice.dll` matches through the `(\.|\.dll$)` alternation
// while `taleworlds.platformservice.client.dll` does not — that one is a separate entry.
var moddingRootBinExcludes = []*regexp.Regexp{
	regexp.MustCompile(`^taleworlds\.diamond\.accessprovider\.`),
	regexp.MustCompile(`^taleworlds\.mountandblade\.launcher\.`),
	regexp.MustCompile(`^taleworlds\.platformservice(\.|\.dll$)`),
	regexp.MustCompile(`^taleworlds\.servicediscovery\.client\.dll$`),
	regexp.MustCompile(`^taleworlds\.starter\.library\.dll$`),
	regexp.MustCompile(`\.test\.dll$`),
}

// GetXMLValue mirrors getXmlValue: the value of `value=` on the FIRST tag whose name matches,
// case-insensitively, with a word boundary after the tag name.
//
// ★ IT IS A REGEX OVER THE WHOLE DOCUMENT, NOT AN XML PARSE, and that has two consequences the
// caller depends on: it finds the element wherever it nests, and it will also match a tag inside a
// COMMENT. Both are the original's behaviour. The tag name is escaped before it is interpolated,
// so a name containing regex metacharacters is matched literally.
//
// ★ THE QUOTE STYLE IS PART OF THE PATTERN: value must be wrapped in " or ', and the capture
// excludes both quote characters, so an attribute using one style is read correctly and a
// mismatch (opening " with closing ') does not match at all.
func GetXMLValue(raw, tagName string) *string {
	if raw == "" {
		return nil
	}

	escaped := regexp.QuoteMeta(tagName)
	re, err := regexp.Compile(`(?i)<` + escaped + `\b[^>]*\bvalue\s*=\s*["']([^"']+)["']`)
	if err != nil {
		return nil
	}

	m := re.FindStringSubmatch(raw)
	if len(m) < 2 {
		return nil
	}
	v := m[1]
	return &v
}

// baseName mirrors node:path basename for the paths this package sees.
//
// ★ NOT filepath.Base. The TypeScript's basename is the POSIX/Node one, and these paths arrive from
// the index with FORWARD slashes; filepath.Base on Windows treats both separators as separators,
// which happens to agree for these inputs but would NOT agree on Linux for a backslash path. Both
// separators are handled here so the function is correct either way, and a trailing separator is
// stripped first, as Node does. (A sibling port in internal/tools carries the same helper for the
// same reason; the two are not shared because that one is in package tools and this package must
// not import a tool body to get a path helper.)
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

// stripLeadingDotSlash mirrors `.replace(/^\.\/+/, ”)`: one or more `./` prefixes at the START of
// the string are removed, but only the dot and slash characters — `../` and a lone `.` are left
// alone, because the pattern requires the slash.
func stripLeadingDotSlash(s string) string {
	for strings.HasPrefix(s, "./") {
		s = s[2:]
	}
	return s
}
