package tools

import (
	"fmt"
	"strings"
)

// ModConflictReport is the result of analysing several modules together.
type ModConflictReport struct {
	ModCount        int               `json:"mod_count"`
	Declarations    int               `json:"declarations"`
	Conflicts       []PatchConflict   `json:"conflicts"`
	PerModule       []ModulePatchInfo `json:"per_module"`
	Unreadable      []string          `json:"unreadable"`
	SkippedFileN    int               `json:"skipped_files"`
}

// ModulePatchInfo records what was found (or not read) per module.
type ModulePatchInfo struct {
	ModuleID     string `json:"module_id"`
	Dir          string `json:"dir"`
	Read         bool   `json:"read"`
	Declarations int    `json:"declarations"`
}

// AnalyzeModConflicts scans each directory and reports cross-mod target competition.
//
// A directory that cannot be read is REPORTED rather than skipped: a run that silently drops
// one of three modules would under-report conflicts, and "no conflicts found" for a corpus it
// never read is exactly the shape of failure this project keeps finding.
func AnalyzeModConflicts(dirs []string, moduleIDs []string) (*ModConflictReport, error) {
	report := &ModConflictReport{
		ModCount:  len(dirs),
		PerModule: []ModulePatchInfo{},
		Conflicts: []PatchConflict{},
	}

	var all []PatchDeclaration
	skippedTotal := 0

	for i, dir := range dirs {
		dir = strings.TrimSpace(dir)
		moduleID := ""
		if i < len(moduleIDs) {
			moduleID = strings.TrimSpace(moduleIDs[i])
		}
		if moduleID == "" {
			moduleID = baseName(dir)
		}

		info, statErr := statDir(dir)
		if statErr != nil || !info {
			report.PerModule = append(report.PerModule, ModulePatchInfo{ModuleID: moduleID, Dir: dir, Read: false})
			report.Unreadable = append(report.Unreadable, moduleID)
			continue
		}

		files := CollectCsharpFiles(dir, 0)
		declarations, skipped := ScanPatchDeclarations(dir, moduleID, files)
		all = append(all, declarations...)
		skippedTotal += len(skipped)

		report.PerModule = append(report.PerModule, ModulePatchInfo{
			ModuleID:     moduleID,
			Dir:          dir,
			Read:         true,
			Declarations: len(declarations),
		})
	}

	report.Declarations = len(all)
	report.Conflicts = FindPatchConflicts(all)
	report.SkippedFileN = skippedTotal
	return report, nil
}

func statDir(dir string) (bool, error) {
	info, err := osStat(dir)
	if err != nil {
		return false, err
	}
	return info, nil
}


// FormatModConflicts renders the report.
//
// Ordering leads with severity, not with counts: a list sorted by target name buries the one
// that matters - two transpilers on one method, where the failure is invalid IL rather than a
// wrong value.
func FormatModConflicts(r *ModConflictReport, includeDeclarations bool, declarations []PatchDeclaration) string {
	var b strings.Builder
	fmt.Fprintf(&b, "mod_count: %d\n", r.ModCount)
	fmt.Fprintf(&b, "declarations_found: %d\n", r.Declarations)
	fmt.Fprintf(&b, "conflict_count: %d\n", len(r.Conflicts))

	transpilerClashes := 0
	for _, c := range r.Conflicts {
		if c.Severity == "transpiler_clash" {
			transpilerClashes++
		}
	}
	fmt.Fprintf(&b, "transpiler_clashes: %d\n", transpilerClashes)
	if len(r.Unreadable) > 0 {
		fmt.Fprintf(&b, "unreadable_modules: %s\n", strings.Join(r.Unreadable, ", "))
	}

	b.WriteString("\nconflicts:\n")
	if len(r.Conflicts) == 0 {
		b.WriteString("  (none found)\n")
	}
	for _, c := range r.Conflicts {
		target := c.TargetType
		if c.TargetMethod != "" {
			target += "." + c.TargetMethod
		}
		fmt.Fprintf(&b, "  [%s] %s  owners: %s\n", c.Severity, target, strings.Join(c.Owners, ", "))
		for _, e := range c.Evidence {
			fmt.Fprintf(&b, "      %s\n", e)
		}
	}

	b.WriteString("\nper_module:\n")
	for _, m := range r.PerModule {
		if m.Read {
			fmt.Fprintf(&b, "  %s: %d declaration(s)\n", m.ModuleID, m.Declarations)
		} else {
			fmt.Fprintf(&b, "  %s: NOT READABLE (%s)\n", m.ModuleID, m.Dir)
		}
	}

	if includeDeclarations {
		b.WriteString("\ndeclarations:\n")
		sorted := make([]PatchDeclaration, len(declarations))
		copy(sorted, declarations)
		for _, d := range sorted {
			target := d.TargetType
			if d.TargetMethod != "" {
				target += "." + d.TargetMethod
			}
			kindStrs := make([]string, 0, len(d.Kinds))
			for _, k := range d.Kinds {
				kindStrs = append(kindStrs, string(k))
			}
			fmt.Fprintf(&b, "  %s: %s  [%s]  %s:%d\n", d.ModuleID, target, strings.Join(kindStrs, ","), d.FilePath, d.Line)
		}
	}

	// The boundary is part of the answer, not a footnote: a reader must not take this for a
	// statement about runtime.
	b.WriteString("\nboundaries:\n")
	b.WriteString("  Static analysis: no game was started and no assembly was loaded.\n")
	b.WriteString("  A declaration is not proof of a live patch - a mod may be disabled, or its patch conditional at runtime.\n")
	b.WriteString("  Confirm against the live patch probe in a running game to see what actually took effect.\n")
	if r.SkippedFileN > 0 {
		fmt.Fprintf(&b, "  %d file(s) could not be read.\n", r.SkippedFileN)
	}
	return b.String()
}
