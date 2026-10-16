// Package tools: static multi-mod Harmony patch conflict analysis.
//
// WHY THIS EXISTS - the gap it fills is BETWEEN two things that already worked.
//
//	doctor (static)     reads a module tree and reports dependency problems, duplicate shared
//	                    DLLs, load-order cycles. It answers "will these modules load".
//	patch probe (live)  introspects a RUNNING game and reports who patched which method. It
//	                    needs the game up, and can only speak about conflicts that happened.
//
// Nothing connected them. Between "these modules declare compatible dependencies" and "two
// owners show up on one method at runtime" lies the question a modder actually asks before
// launching: WHICH mods are going to fight over the same method? That is answerable from
// source, and it is the part of multi-mod verification that does not need the game.
//
// SEVERITY IS THE PRODUCT. Two mods patching one method is a risk, but the failure mode
// differs sharply by patch kind, and that ordering is the reason to have the tool at all:
//
//	transpiler vs transpiler   both rewrite IL; the combination can be invalid IL rather than
//	                           a wrong result.
//	any vs finalizer           a finalizer wraps the whole invocation; stacking is rarely meant.
//	prefix/postfix overlap     usually tolerable, often deliberate, still worth naming.
//
// WHAT IT DOES NOT DO: it does not run anything and does not prove a conflict will occur. A
// patch may be conditional, a mod may be disabled, a transpiler may compose harmlessly. The
// report says "these declarations compete", names the evidence, and stops.
package tools

import (
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// PatchKind classifies a Harmony patch method.
type PatchKind string

const (
	PatchPrefix    PatchKind = "prefix"
	PatchPostfix   PatchKind = "postfix"
	PatchTranspile PatchKind = "transpiler"
	PatchFinalizer PatchKind = "finalizer"
)

// PatchDeclaration is one [HarmonyPatch] attribute found in source.
type PatchDeclaration struct {
	ModuleID     string      `json:"module_id"`
	FilePath     string      `json:"file_path"`
	Line         int         `json:"line"`
	TargetType   string      `json:"target_type"`
	TargetMethod string      `json:"target_method"`
	Kinds        []PatchKind `json:"kinds"`
}

// PatchConflict is a target with more than one owning module.
type PatchConflict struct {
	TargetType   string   `json:"target_type"`
	TargetMethod string   `json:"target_method"`
	Owners       []string `json:"owners"`
	Severity     string   `json:"severity"`
	Evidence     []string `json:"evidence"`
}

// ── the attribute grammar ───────────────────────────────────────────────────
//
// Harmony's attribute accepts several shapes and the parser handles the ones real mods use:
//
//	[HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]
//	[HarmonyPatch(typeof(Hero), nameof(Hero.CanBecomePrisoner))]
//	[HarmonyPatch(typeof(Hero))]
//	[HarmonyPatch("Hero", "CanBecomePrisoner")]
//	[HarmonyPatch(typeof(Hero), "Method", new Type[] { typeof(int) })]
//
// ★ THE nameof FORM IS WHY THIS IS NOT A SINGLE REGEX. The method name is written as a C#
// expression, and a matcher that only accepts quoted strings silently skips every mod using
// the idiom the engine's own documentation recommends - reporting "no conflicts" for a corpus
// full of them. A negative control confirmed it: disabling nameof handling fails three
// assertions in the test suite.

var (
	reHarmonyPatch = regexp.MustCompile(`\[HarmonyPatch\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\]`)
	reTypeofArg    = regexp.MustCompile(`^typeof\s*\(\s*([\w.<>\[\]]+)\s*\)$`)
	reNameofArg    = regexp.MustCompile(`^nameof\s*\(\s*[\w.]*?(\w+)\s*\)$`)
	reQuotedArg    = regexp.MustCompile(`^["']([^"']+)["']$`)
)

// parseHarmonyPatchArguments extracts the target from an attribute's argument list.
func parseHarmonyPatchArguments(args string) (targetType, targetMethod string) {
	parts := splitTopLevel(args)

	if len(parts) > 0 {
		first := strings.TrimSpace(parts[0])
		if m := reTypeofArg.FindStringSubmatch(first); m != nil {
			targetType = m[1]
		} else if m := reQuotedArg.FindStringSubmatch(first); m != nil {
			targetType = m[1]
		}
	}
	if len(parts) > 1 {
		second := strings.TrimSpace(parts[1])
		if m := reNameofArg.FindStringSubmatch(second); m != nil {
			targetMethod = m[1]
		} else if m := reQuotedArg.FindStringSubmatch(second); m != nil {
			targetMethod = m[1]
		}
	}
	return targetType, targetMethod
}

// splitTopLevel splits on commas that are not nested inside brackets or quotes.
func splitTopLevel(text string) []string {
	var out []string
	depth := 0
	var quote rune
	var current strings.Builder

	for _, ch := range text {
		if quote != 0 {
			current.WriteRune(ch)
			if ch == quote {
				quote = 0
			}
			continue
		}
		switch ch {
		case '"', '\'':
			quote = ch
			current.WriteRune(ch)
		case '(', '[', '{':
			depth++
			current.WriteRune(ch)
		case ')', ']', '}':
			depth--
			current.WriteRune(ch)
		case ',':
			if depth == 0 {
				out = append(out, current.String())
				current.Reset()
			} else {
				current.WriteRune(ch)
			}
		default:
			current.WriteRune(ch)
		}
	}
	if strings.TrimSpace(current.String()) != "" {
		out = append(out, current.String())
	}
	return out
}

var kindMatchers = []struct {
	re   *regexp.Regexp
	kind PatchKind
}{
	{regexp.MustCompile(`\[Harmony(?:Prefix)\b`), PatchPrefix},
	{regexp.MustCompile(`\[Harmony(?:Postfix)\b`), PatchPostfix},
	{regexp.MustCompile(`\[Harmony(?:Transpiler)\b`), PatchTranspile},
	{regexp.MustCompile(`\[Harmony(?:Finalizer)\b`), PatchFinalizer},
}

// pruneDirs never hold authored source and can be large.
var patchPruneDirs = map[string]bool{
	".git": true, "node_modules": true, "bin": true, "obj": true,
	".vs": true, ".idea": true, "__pycache__": true,
}

// CollectCsharpFiles walks root for .cs files, skipping build output.
func CollectCsharpFiles(root string, limit int) []string {
	if limit <= 0 {
		limit = 4000
	}
	var found []string
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if len(found) >= limit {
			return filepath.SkipAll
		}
		if d.IsDir() {
			if patchPruneDirs[d.Name()] && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.EqualFold(filepath.Ext(d.Name()), ".cs") {
			rel, relErr := filepath.Rel(root, path)
			if relErr != nil {
				rel = path
			}
			found = append(found, filepath.ToSlash(rel))
		}
		return nil
	})
	sort.Strings(found)
	return found
}

// ScanPatchDeclarations reads one module's files and collects its patch declarations.
func ScanPatchDeclarations(modRoot, moduleID string, files []string) ([]PatchDeclaration, []string) {
	var declarations []PatchDeclaration
	var skipped []string

	for _, rel := range files {
		data, err := os.ReadFile(filepath.Join(modRoot, filepath.FromSlash(rel)))
		if err != nil {
			skipped = append(skipped, rel)
			continue
		}
		text := string(data)

		var kinds []PatchKind
		for _, km := range kindMatchers {
			if km.re.MatchString(text) {
				kinds = append(kinds, km.kind)
			}
		}
		if len(kinds) == 0 {
			continue
		}

		lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
		for i, line := range lines {
			if !strings.Contains(line, "HarmonyPatch") {
				continue
			}
			// The attribute can wrap; a three-line window covers the real forms without
			// swallowing a neighbouring attribute.
			end := i + 3
			if end > len(lines) {
				end = len(lines)
			}
			window := strings.Join(lines[i:end], " ")
			m := reHarmonyPatch.FindStringSubmatch(window)
			if m == nil {
				continue
			}
			targetType, targetMethod := parseHarmonyPatchArguments(m[1])
			if targetType == "" && targetMethod == "" {
				continue
			}
			declarations = append(declarations, PatchDeclaration{
				ModuleID:     moduleID,
				FilePath:     filepath.ToSlash(rel),
				Line:         i + 1,
				TargetType:   targetType,
				TargetMethod: targetMethod,
				Kinds:        kinds,
			})
		}
	}
	return declarations, skipped
}

var severityRank = map[string]int{
	"transpiler_clash":        3,
	"finalizer_overlap":       2,
	"prefix_postfix_overlap":  1,
}

// FindPatchConflicts groups declarations by target and reports those with >1 owner.
func FindPatchConflicts(declarations []PatchDeclaration) []PatchConflict {
	type key struct{ typ, method string }
	groups := map[key][]PatchDeclaration{}
	order := []key{}

	for _, d := range declarations {
		k := key{strings.ToLower(d.TargetType), strings.ToLower(d.TargetMethod)}
		if _, seen := groups[k]; !seen {
			order = append(order, k)
		}
		groups[k] = append(groups[k], d)
	}

	var conflicts []PatchConflict
	for _, k := range order {
		group := groups[k]

		ownerSet := map[string]bool{}
		for _, d := range group {
			ownerSet[d.ModuleID] = true
		}
		// Two patching methods inside ONE mod is that mod's business. The question here is
		// multi-mod, so a single owner is not a conflict and is not reported.
		if len(ownerSet) < 2 {
			continue
		}

		owners := make([]string, 0, len(ownerSet))
		for o := range ownerSet {
			owners = append(owners, o)
		}
		sort.Strings(owners)

		transpilerOwners := map[string]bool{}
		hasFinalizer := false
		for _, d := range group {
			for _, kind := range d.Kinds {
				if kind == PatchTranspile {
					transpilerOwners[d.ModuleID] = true
				}
				if kind == PatchFinalizer {
					hasFinalizer = true
				}
			}
		}

		severity := "prefix_postfix_overlap"
		if len(transpilerOwners) >= 2 {
			severity = "transpiler_clash"
		} else if hasFinalizer {
			severity = "finalizer_overlap"
		}

		sorted := make([]PatchDeclaration, len(group))
		copy(sorted, group)
		sort.Slice(sorted, func(i, j int) bool {
			if sorted[i].ModuleID != sorted[j].ModuleID {
				return sorted[i].ModuleID < sorted[j].ModuleID
			}
			return sorted[i].Line < sorted[j].Line
		})

		evidence := make([]string, 0, len(sorted))
		for _, d := range sorted {
			kindStrs := make([]string, 0, len(d.Kinds))
			for _, kk := range d.Kinds {
				kindStrs = append(kindStrs, string(kk))
			}
			evidence = append(evidence, d.ModuleID+": "+d.FilePath+":"+itoa(d.Line)+"  ["+strings.Join(kindStrs, ",")+"]")
		}

		conflicts = append(conflicts, PatchConflict{
			TargetType:   group[0].TargetType,
			TargetMethod: group[0].TargetMethod,
			Owners:       owners,
			Severity:     severity,
			Evidence:     evidence,
		})
	}

	sort.Slice(conflicts, func(i, j int) bool {
		if severityRank[conflicts[i].Severity] != severityRank[conflicts[j].Severity] {
			return severityRank[conflicts[i].Severity] > severityRank[conflicts[j].Severity]
		}
		a := conflicts[i].TargetType + "." + conflicts[i].TargetMethod
		b := conflicts[j].TargetType + "." + conflicts[j].TargetMethod
		return a < b
	})
	return conflicts
}
