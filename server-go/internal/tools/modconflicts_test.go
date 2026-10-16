package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// buildPatchCorpus lays out the same scenario the TypeScript test uses, so a divergence
// between the two implementations fails on one side rather than going unnoticed.
func buildPatchCorpus(t *testing.T) string {
	t.Helper()
	root := t.TempDir()

	put := func(rel, body string) {
		full := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	// ModA declares for the same target. It does NOT transpile, so it must not be sufficient
	// on its own to make a transpiler clash - that rule needs two transpiler owners.
	put("ModA/P.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Hero), \"CanBecomePrisoner\")]\n[HarmonyPrefix]\nclass A {}\n")
	put("ModB/P.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Hero), \"CanBecomePrisoner\")]\n[HarmonyTranspiler]\nclass B {}\n")
	put("ModC/P.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Hero), nameof(Hero.CanBecomePrisoner))]\n[HarmonyTranspiler]\nclass C {}\n")

	// Two patching classes inside ONE mod: that mod's business, not a multi-mod conflict.
	put("ModE/E1.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Item), \"GetValue\")]\n[HarmonyPrefix]\nclass E1 {}\n")
	put("ModE/E2.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Item), \"GetValue\")]\n[HarmonyPostfix]\nclass E2 {}\n")

	// Build output must never be scanned.
	put("ModA/bin/Debug/Ghost.cs", "using HarmonyLib;\n[HarmonyPatch(typeof(Settlement), \"Name\")]\n[HarmonyTranspiler]\nclass Ghost {}\n")

	return root
}

func TestParseHarmonyPatchArguments(t *testing.T) {
	cases := []struct {
		in           string
		wantType     string
		wantMethod   string
	}{
		{`typeof(Hero), "CanBecomePrisoner"`, "Hero", "CanBecomePrisoner"},
		{`typeof(Hero), nameof(Hero.CanBecomePrisoner)`, "Hero", "CanBecomePrisoner"},
		{`typeof(TaleWorlds.CampaignSystem.Hero), nameof(TaleWorlds.CampaignSystem.Hero.Name)`, "TaleWorlds.CampaignSystem.Hero", "Name"},
		{`"Hero", "CanBecomePrisoner"`, "Hero", "CanBecomePrisoner"},
		{`typeof(Hero)`, "Hero", ""},
		{`typeof(Hero), "M", new Type[] { typeof(int) }`, "Hero", "M"},
	}
	for _, c := range cases {
		gotType, gotMethod := parseHarmonyPatchArguments(c.in)
		if gotType != c.wantType || gotMethod != c.wantMethod {
			t.Errorf("parse(%q) = (%q,%q), want (%q,%q)", c.in, gotType, gotMethod, c.wantType, c.wantMethod)
		}
	}
}

func TestSplitTopLevel(t *testing.T) {
	if got := len(splitTopLevel(`typeof(Hero), "M", new Type[] { typeof(int), typeof(string) }`)); got != 3 {
		t.Errorf("top-level split = %d parts, want 3", got)
	}
	if got := len(splitTopLevel(`typeof(Dictionary<int, string>)`)); got != 1 {
		t.Errorf("generic split = %d parts, want 1", got)
	}
}

func TestAnalyzeModConflicts_FindsTranspilerClashAndNamesOwners(t *testing.T) {
	root := buildPatchCorpus(t)
	dirs := []string{
		filepath.Join(root, "ModA"),
		filepath.Join(root, "ModB"),
		filepath.Join(root, "ModC"),
		filepath.Join(root, "ModE"),
	}

	report, err := AnalyzeModConflicts(dirs, nil)
	if err != nil {
		t.Fatalf("AnalyzeModConflicts: %v", err)
	}

	if len(report.Conflicts) != 1 {
		t.Fatalf("conflicts = %d, want 1 (%+v)", len(report.Conflicts), report.Conflicts)
	}
	c := report.Conflicts[0]
	if c.Severity != "transpiler_clash" {
		t.Errorf("severity = %q, want transpiler_clash", c.Severity)
	}
	if strings.Join(c.Owners, ",") != "ModA,ModB,ModC" {
		t.Errorf("owners = %v, want ModA,ModB,ModC", c.Owners)
	}
	if len(c.Evidence) != 3 {
		t.Errorf("evidence lines = %d, want 3", len(c.Evidence))
	}
}

func TestAnalyzeModConflicts_SingleModIsNotACrossModConflict(t *testing.T) {
	root := buildPatchCorpus(t)
	report, _ := AnalyzeModConflicts([]string{filepath.Join(root, "ModE")}, nil)

	// ModE patches Item.GetValue twice, from two classes. That is one owner, so it is not a
	// multi-mod conflict and must not appear.
	for _, c := range report.Conflicts {
		if c.TargetType == "Item" {
			t.Errorf("a single-mod double patch was reported as a conflict: %+v", c)
		}
	}
}

func TestAnalyzeModConflicts_BuildOutputIsNotScanned(t *testing.T) {
	root := buildPatchCorpus(t)
	report, _ := AnalyzeModConflicts([]string{filepath.Join(root, "ModA")}, nil)

	for _, c := range report.Conflicts {
		if c.TargetType == "Settlement" {
			t.Error("bin/ was scanned")
		}
	}
	for _, d := range []string{} {
		_ = d
	}
	dir := filepath.Join(root, "ModA")
	files := CollectCsharpFiles(dir, 0)
	for _, f := range files {
		if strings.HasPrefix(f, "bin/") || strings.HasPrefix(f, "obj/") {
			t.Errorf("collector returned build output: %s", f)
		}
	}
}

func TestAnalyzeModConflicts_UnreadableModuleIsReported(t *testing.T) {
	root := buildPatchCorpus(t)
	report, err := AnalyzeModConflicts(
		[]string{filepath.Join(root, "ModA"), filepath.Join(root, "does-not-exist")}, nil)
	if err != nil {
		t.Fatalf("AnalyzeModConflicts: %v", err)
	}
	if len(report.Unreadable) != 1 || report.Unreadable[0] != "does-not-exist" {
		t.Errorf("unreadable = %v, want [does-not-exist]", report.Unreadable)
	}
	// And it must show up in the rendered output, not only in the struct.
	text := FormatModConflicts(report, false, nil)
	if !strings.Contains(text, "NOT READABLE") {
		t.Error("the rendered report does not say a module was unreadable")
	}
}

func TestFindPatchConflicts_SeverityRules(t *testing.T) {
	mk := func(module string, kinds ...PatchKind) PatchDeclaration {
		return PatchDeclaration{ModuleID: module, FilePath: module + ".cs", Line: 1,
			TargetType: "T", TargetMethod: "m", Kinds: kinds}
	}

	// ★ ONE transpiler among several owners is NOT a clash. A negative control caught this
	// hole in the TypeScript suite: loosening the rule to "two owners of any kind" changed no
	// result, because no case had exactly one transpiler. The rule that a clash needs two
	// TRANSPILER owners is what separates "invalid IL" from "a wrong value", so it is pinned
	// on both sides.
	one := FindPatchConflicts([]PatchDeclaration{
		mk("A", PatchTranspile), mk("B", PatchPrefix),
	})
	if len(one) != 1 || one[0].Severity != "prefix_postfix_overlap" {
		t.Errorf("one transpiler among owners graded %v, want prefix_postfix_overlap", one)
	}

	two := FindPatchConflicts([]PatchDeclaration{
		mk("A", PatchTranspile), mk("B", PatchTranspile),
	})
	if len(two) != 1 || two[0].Severity != "transpiler_clash" {
		t.Errorf("two transpilers graded %v, want transpiler_clash", two)
	}

	fin := FindPatchConflicts([]PatchDeclaration{
		mk("A", PatchFinalizer), mk("B", PatchPostfix),
	})
	if len(fin) != 1 || fin[0].Severity != "finalizer_overlap" {
		t.Errorf("shared finalizer graded %v, want finalizer_overlap", fin)
	}

	// A type-only patch and a method patch on that type are different targets.
	separate := FindPatchConflicts([]PatchDeclaration{
		{ModuleID: "A", TargetType: "S", Kinds: []PatchKind{PatchPostfix}},
		{ModuleID: "B", TargetType: "S", TargetMethod: "n", Kinds: []PatchKind{PatchPostfix}},
	})
	if len(separate) != 0 {
		t.Errorf("a type-only patch was merged with a method patch: %+v", separate)
	}
}

func TestFormatModConflicts_StatesItsBoundary(t *testing.T) {
	root := buildPatchCorpus(t)
	report, _ := AnalyzeModConflicts([]string{
		filepath.Join(root, "ModA"), filepath.Join(root, "ModB"), filepath.Join(root, "ModC"),
	}, nil)

	text := FormatModConflicts(report, false, nil)
	for _, want := range []string{
		"no game was started",
		"not proof of a live patch",
		"conflict_count: 1",
		"transpiler_clashes: 1",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("report is missing %q:\n%s", want, text)
		}
	}
}
