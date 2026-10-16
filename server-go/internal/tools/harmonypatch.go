package tools

import (
	"database/sql"
	"fmt"
	"strings"
)

// GenerateHarmonyPatch mirrors generateHarmonyPatch(className, methodName) from
// src/tools/generate-harmony-patch.ts: the AST-index lookup, the overload hints and the
// patch template, rendered exactly as the TypeScript renders them.
//
// ★ THE TWO QUERIES AND THEIR ORDERING ARE THE CONTRACT.
//
//   - the TYPE row: `WHERE typeName = $name ORDER BY LENGTH(fullName), filePath LIMIT 1`
//     — the SHORTEST full name wins, with filePath as the tiebreaker. A port that
//     ordered by fullName alphabetically would pick TaleWorlds.Core.MobileParty over
//     the real CampaignSystem one whenever both exist.
//   - the METHOD rows: `WHERE typeFullName = $typeFullName AND memberName = $methodName
//     ORDER BY startLine` — ALL overloads, in source order, no LIMIT.
//
// ★ NOT-FOUND IS A TOOL ANSWER, NOT AN ERROR: `Type not found: ${className}` is a normal
// text result (the TS returns it as content), while a database failure propagates. The
// same distinction ReadCsharpType carries.
//
// ★ ZERO METHODS IS ALSO A NORMAL ANSWER. When the type exists but the method does not,
// overloadHints becomes the fixed sentence 'Method signature was not found in the AST
// index. Run bun run setup to rebuild the index first.' and the template still renders —
// the caller gets a scaffold to edit, not a refusal.
func GenerateHarmonyPatch(db *sql.DB, className, methodName string) (string, error) {
	var typeFullName, filePath string
	err := db.QueryRow(`
		SELECT fullName, filePath
		FROM csharp_types
		WHERE typeName = ?
		ORDER BY LENGTH(fullName), filePath
		LIMIT 1`, className).Scan(&typeFullName, &filePath)
	if err == sql.ErrNoRows {
		return "Type not found: " + className, nil
	}
	if err != nil {
		return "", err
	}

	rows, err := db.Query(`
		SELECT filePath, signature, isStatic, memberKind
		FROM csharp_methods
		WHERE typeFullName = ?
			AND memberName = ?
		ORDER BY startLine`, typeFullName, methodName)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	type methodRow struct {
		filePath  string
		signature string
		isStatic  int64
	}
	methods := make([]methodRow, 0, 4)
	for rows.Next() {
		var m methodRow
		var memberKind string
		if err := rows.Scan(&m.filePath, &m.signature, &m.isStatic, &memberKind); err != nil {
			return "", err
		}
		methods = append(methods, m)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}

	// Instance methods need __instance injected as the first patch parameter; with
	// several overloads we can't tell statically, so leave a marker comment.
	//
	// ★ THE THREE BRANCHES, VERBATIM:
	//   exactly one method, and it is an instance method -> the parameter, spliced in
	//   several methods, ANY of them instance            -> the marker comment
	//   otherwise (all static / none)                     -> empty string
	instanceParamHint := ""
	hasInstance := false
	for _, m := range methods {
		if m.isStatic == 0 {
			hasInstance = true
			break
		}
	}
	if len(methods) == 1 && methods[0].isStatic == 0 {
		instanceParamHint = className + " __instance, "
	} else if hasInstance {
		instanceParamHint = "/* If this is an instance method, add " + className + " __instance here. */ "
	}

	overloadHints := "// Method signature was not found in the AST index. Run bun run setup to rebuild the index first."
	if len(methods) > 0 {
		parts := make([]string, 0, len(methods))
		for i, m := range methods {
			lines := []string{fmt.Sprintf("// [%d] %s", i+1, m.signature)}
			if typeHint := buildHarmonyTypeHint(m.signature); typeHint != "" {
				lines = append(lines, "// Overload hint: new Type[] { "+typeHint+" }")
			}
			// The TS builds [comment, typeHint-or-''].filter(Boolean).join('\n') per method
			// and joins methods with '\n// \n' — note the SPACE inside that middle comment.
			parts = append(parts, strings.Join(lines, "\n"))
		}
		overloadHints = strings.Join(parts, "\n// \n")
	}

	patchTemplate := `// Auto-generated Harmony patch template
// Target type: ` + typeFullName + `
// Source file: ` + filePath + `

` + overloadHints + `

using HarmonyLib;
using System;

namespace YourModNamespace.Patches
{
    // If there are multiple overloads, switch to the HarmonyPatch overload
    // that includes a parameter type array.
    // [HarmonyPatch(typeof(` + className + `), "` + methodName + `", new Type[] { /* typeof(int), typeof(string) */ })]
    [HarmonyPatch(typeof(` + className + `), "` + methodName + `")]
    public static class ` + sanitizeHarmonyIdentifier(className) + `_` + sanitizeHarmonyIdentifier(methodName) + `_Patch
    {
        static void Prefix(` + instanceParamHint + `/* original method args */, /* ref ReturnType __result */)
        {
            // TODO: prefix logic
        }

        static void Postfix(` + instanceParamHint + `/* original method args */, /* ref ReturnType __result */)
        {
            // TODO: postfix logic
        }
    }
}
`

	return patchTemplate, nil
}

// buildHarmonyTypeHint mirrors buildTypeHint(signature): the parameter type list from a
// C# signature rendered as a HarmonyPatch type array. Empty when the signature has no
// parameters — including the "()"-only case, where TS's `end <= start + 1` also returns ''.
func buildHarmonyTypeHint(signature string) string {
	start := strings.Index(signature, "(")
	end := strings.LastIndex(signature, ")")
	if start == -1 || end == -1 || end <= start+1 {
		return ""
	}

	paramsSection := strings.TrimSpace(signature[start+1 : end])
	if paramsSection == "" {
		return ""
	}

	parts := splitHarmonyTopLevel(paramsSection)
	typeNames := make([]string, 0, len(parts))
	for _, param := range parts {
		if typeName := extractHarmonyParamType(param); typeName != "" {
			typeNames = append(typeNames, "typeof("+typeName+")")
		}
	}
	return strings.Join(typeNames, ", ")
}

// splitHarmonyTopLevel mirrors splitTopLevel: split on commas that sit OUTSIDE every
// <>, () and [] nesting. The counters CLAMP AT ZERO on close (Math.max(0, depth-1)), so
// an unbalanced '>' cannot make the depth negative and silently re-enable comma
// splitting — mirrored with the same clamping rather than an error.
func splitHarmonyTopLevel(input string) []string {
	var parts []string
	current := strings.Builder{}
	angle, paren, bracket := 0, 0, 0

	for _, char := range input {
		switch char {
		case '<':
			angle++
		case '>':
			if angle > 0 {
				angle--
			}
		case '(':
			paren++
		case ')':
			if paren > 0 {
				paren--
			}
		case '[':
			bracket++
		case ']':
			if bracket > 0 {
				bracket--
			}
		case ',':
			if angle == 0 && paren == 0 && bracket == 0 {
				if trimmed := strings.TrimSpace(current.String()); trimmed != "" {
					parts = append(parts, trimmed)
				}
				current.Reset()
				continue
			}
		}
		current.WriteRune(char)
	}
	if trimmed := strings.TrimSpace(current.String()); trimmed != "" {
		parts = append(parts, trimmed)
	}
	return parts
}

// extractHarmonyParamType mirrors extractTypeFromParam:
//
//	"ref Foo bar" / "params int[] xs" / "Foo bar = default" -> "Foo" / "int[]"
//
// The modifiers are stripped by the REGEX ^\s*(ref|out|in|params|this|scoped|readonly)\s+ —
// ONE leading occurrence, not a loop. "ref readonly Foo x" is JS-split on '=' first
// (yielding "ref readonly Foo x"), then loses only "ref " to the regex: the result
// "readonly Foo" then splits at the LAST space into "readonly". That is the original's
// behaviour for double modifiers and it is kept rather than "fixed".
func extractHarmonyParamType(param string) string {
	withoutDefault := strings.TrimSpace(strings.Split(param, "=")[0])
	// One leading modifier, mirroring the regex (not g-flagged).
	if idx := strings.Index(withoutDefault, " "); idx > 0 {
		first := withoutDefault[:idx]
		switch first {
		case "ref", "out", "in", "params", "this", "scoped", "readonly":
			withoutDefault = strings.TrimSpace(withoutDefault[idx+1:])
		}
	}
	lastSpace := strings.LastIndex(withoutDefault, " ")
	if lastSpace == -1 {
		return withoutDefault
	}
	return strings.TrimSpace(withoutDefault[:lastSpace])
}

// sanitizeHarmonyIdentifier mirrors sanitizeIdentifier: every character outside
// [A-Za-z0-9_] becomes '_'.
func sanitizeHarmonyIdentifier(input string) string {
	out := []rune(input)
	for i, r := range out {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '_':
		default:
			out[i] = '_'
		}
	}
	return string(out)
}
