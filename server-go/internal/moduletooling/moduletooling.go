// Package moduletooling ports the analysis half of src/utils/bannerlord-module-tooling.ts: the
// module model built from a SubModule.xml tree, the doctor's issue detection, the load-order
// topological sort, and the focus selection.
//
// ★ WHAT IS NOT PORTED, AND WHY IT IS STATED HERE RATHER THAN LEFT IMPLICIT:
//   - the FILE SYSTEM half (loadBannerlordModules, scanModuleDlls, walkFiles, pathExists). Those
//     read a real install; internal/mods already carries the walker with the same symlink rule this
//     file's original documents, and re-implementing it here would be a second copy of a rule that
//     two places must agree on (F25). A caller supplies the already-parsed ModuleInfo values.
//   - the MD5 computation, which exists only for the shared-dependency variant check. The MD5 is
//     carried on the input as an optional value, so the analysis below is complete without it.
//   - resolveBannerlordDoctorGameDir, which is a search across configured, setup-state and detected
//     directories. It is environment discovery, like gameprofiles' detector.
//
// ★ THE ISSUE TYPE STRINGS ARE THE CONTRACT. They are what `bannerlord_doctor` prints and what a
// user greps for, so they are preserved verbatim rather than normalised, and the differential
// compares them exactly.
package moduletooling

import (
	"path/filepath"
	"strings"

	"blore/internal/report"
)

// RefMetadata mirrors BannerlordModuleRefMetadata.
type RefMetadata struct {
	ModuleID string
	Order    string
	HasOrder bool
	Optional bool
	Version  string
	HasVer   bool
}

// SubModuleInfo mirrors BannerlordSubModuleInfo.
type SubModuleInfo struct {
	Name       string
	HasName    bool
	DLLName    string
	HasDLLName bool
	ClassType  string
	HasClass   bool
	Assemblies []string
	Tags       []string
}

// DLLInfo mirrors BannerlordModuleDllInfo. MD5 is present only for the shared-dependency DLLs, which
// is what the original computes it for.
type DLLInfo struct {
	FileName     string
	RelativePath string
	MD5          string
	HasMD5       bool
}

// ModuleInfo mirrors BannerlordModuleInfo.
type ModuleInfo struct {
	ModuleID       string
	ModuleName     string
	Version        string
	HasVersion     bool
	ModuleType     string
	HasType        bool
	ModuleCategory string
	HasCategory    bool
	OfficialFlag   bool
	HasOfficial    bool
	DefaultModule  bool
	HasDefault     bool
	IsOfficial     bool
	ModuleDir      string
	SubModulePath  string
	Dependencies   []string
	LoadAfter      []string
	Incompatible   []string
	DepMetadata    []RefMetadata
	SubModules     []SubModuleInfo
	DLLFiles       []DLLInfo
}

// Issue mirrors BannerlordDoctorIssue.
type Issue struct {
	Severity        string
	IssueType       string
	ModuleID        string
	HasModuleID     bool
	RelatedModuleID string
	HasRelated      bool
	FilePath        string
	HasFilePath     bool
	DLLName         string
	HasDLL          bool
	Detail          string
}

// officialModuleIDs mirrors OFFICIAL_MODULE_IDS.
//
// ★ THE SET CONTAINS BOTH `Sandbox` AND `SandBox`, and that is not a typo being tolerated — it is an
// accommodation in the ORIGINAL's own data, because the id is compared VERBATIM
// (`OFFICIAL_MODULE_IDS.has(moduleId)`) while the type is compared case-INSENSITIVELY. Both
// spellings are load-bearing: a module whose id is exactly `SandBox` is official only because of the
// second entry, and the corpus contains such a module for that reason.
var officialModuleIDs = map[string]struct{}{
	"Native": {}, "SandBoxCore": {}, "Sandbox": {}, "SandBox": {},
	"StoryMode": {}, "CustomBattle": {}, "BirthAndDeath": {}, "FastMode": {},
	"Multiplayer": {}, "NavalDLC": {},
}

// IsOfficial decides officialness the way the original's loader does, and it is EXPORTED because the
// loader itself is not ported (see the package note): a caller that supplies parsed modules needs
// this rule to build ModuleInfo.IsOfficial, and inlining it at the call site would be a second copy
// of a three-branch rule.
//
// ★ THE THREE BRANCHES ARE NOT ALTERNATIVES, THEY ARE A UNION, and they disagree on CASE:
//
//	officialFlag === true                     exact boolean
//	moduleType.trim().toLowerCase() === 'official'   case-INSENSITIVE, and TRIMMED
//	OFFICIAL_MODULE_IDS.has(moduleId)         case-SENSITIVE, verbatim
//
// So a module whose type is `Official` IS official while one whose id is `SANDBOX` is NOT, and a
// module with `Official: false` whose id is in the set IS. The differential pins all three, and the
// set's two spellings exist precisely because the third branch cannot fold case.
//
// ★ THE TRIM IS PART OF THE CONTRACT, NOT A CONVENIENCE FOR CALLERS. In the original the XML value
// passes through getNodeValue, which TRIMS every string it returns — so `  official  ` reaches this
// rule as `official` and the module is official. The first version of this predicate compared the
// type without trimming, and the differential failed on exactly that matrix row: `  official  `
// came back false here and true from the real loader. Because this function is EXPORTED for callers
// that parse XML themselves, the trim has to happen HERE rather than being assumed of the input.
func IsOfficial(moduleID, moduleType string, officialFlag bool, hasOfficialFlag bool) bool {
	if hasOfficialFlag && officialFlag {
		return true
	}
	if strings.EqualFold(report.TrimJS(moduleType), "official") && moduleType != "" {
		return true
	}
	_, ok := officialModuleIDs[moduleID]
	return ok
}

// sharedDependencyDLLToModule mirrors SHARED_DEPENDENCY_DLL_TO_MODULE, keyed by LOWERCASE file name
// because the lookup lowercases before consulting it.
var sharedDependencyDLLToModule = map[string]string{
	"0harmony.dll":               "Bannerlord.Harmony",
	"bannerlord.blse.shared.dll": "Bannerlord.BLSE",
	"bannerlord.butterlib.dll":   "Bannerlord.ButterLib",
	"bannerlord.moduleloader.bannerlord.mboptionscreen.dll": "Bannerlord.MBOptionScreen",
	"bannerlord.mboptionscreen.dll":                         "Bannerlord.MBOptionScreen",
	"bannerlord.uiextenderex.dll":                           "Bannerlord.UIExtenderEx",
}

// ComputeDoctorFocusModules mirrors computeDoctorFocusModules.
//
// ★ THE PRECEDENCE IS PATH, THEN ID, THEN EVERYTHING NON-OFFICIAL. A path wins over an id when both
// are supplied, the id comparison is EXACT (after a trim) rather than a prefix or a substring match,
// and the fallback is the non-official modules — or ALL modules when every module is official. So a
// pure-vanilla install focuses on everything rather than on nothing.
func ComputeDoctorFocusModules(modules []ModuleInfo, moduleID, modulePath string) []ModuleInfo {
	if strings.TrimSpace(modulePath) != "" {
		resolved := report.TrimJS(modulePath)
		out := make([]ModuleInfo, 0, 4)
		for _, moduleInfo := range modules {
			if sameResolvedPath(moduleInfo.ModuleDir, resolved) {
				out = append(out, moduleInfo)
			}
		}
		return out
	}

	if strings.TrimSpace(moduleID) != "" {
		wanted := report.TrimJS(moduleID)
		out := make([]ModuleInfo, 0, 4)
		for _, moduleInfo := range modules {
			if moduleInfo.ModuleID == wanted {
				out = append(out, moduleInfo)
			}
		}
		return out
	}

	nonOfficial := make([]ModuleInfo, 0, len(modules))
	for _, moduleInfo := range modules {
		if !moduleInfo.IsOfficial {
			nonOfficial = append(nonOfficial, moduleInfo)
		}
	}
	if len(nonOfficial) > 0 {
		return nonOfficial
	}
	return modules
}

// sameResolvedPath compares two paths after a JS `resolve`-equivalent normalisation.
//
// `resolve` makes a path absolute against the process directory and collapses `.`/`..`. The paths
// here come from a modules scan (absolute) and from a caller's argument (possibly relative), so the
// comparison has to normalise both. A plain string equality would miss `./Modules/X` vs an absolute
// path, which is precisely the input the path branch exists to accept.
func sameResolvedPath(a, b string) bool {
	return resolveLike(a) == resolveLike(b)
}

// LoadOrder mirrors the return of buildRecommendedLoadOrder.
type LoadOrder struct {
	OrderedModuleIDs    []string
	CycleDetected       bool
	UnresolvedModuleIDs []string
}

// BuildRecommendedLoadOrder mirrors buildRecommendedLoadOrder: Kahn's algorithm over the edges
// collectModuleEdges produces, with the ready set kept SORTED by compareModuleOrder.
//
// ★ THE SORT INSIDE THE LOOP IS THE ALGORITHM, NOT A TIDY-UP. A plain Kahn implementation with a
// FIFO queue would produce A valid order; this produces THE order the doctor recommends, because the
// ready set is re-sorted after every pop. Removing that sort changes which valid order a user sees.
//
// ★ A CYCLE IS REPORTED, NOT RESOLVED: the modules that never reached indegree zero are returned as
// `unresolvedModuleIds` and the flag is set, with no attempt to break the cycle. `cycleDetected` is
// exactly `len(unresolved) > 0`, so it is derivable — carried anyway because it is the field callers
// read.
//
// ★ EDGES ARE DEDUPLICATED PER SOURCE. The original guards with `fromSet.has(to)`, so a module that
// is both a declared dependency and a LoadBeforeThis target contributes ONE edge; without the guard
// the indegree would be incremented twice and the module would never reach zero.
func BuildRecommendedLoadOrder(modules []ModuleInfo) LoadOrder {
	moduleIDs := make([]string, 0, len(modules))
	moduleSet := map[string]struct{}{}
	for _, m := range modules {
		moduleIDs = append(moduleIDs, m.ModuleID)
		moduleSet[m.ModuleID] = struct{}{}
	}

	indegree := map[string]int{}
	outgoing := map[string]map[string]struct{}{}
	for _, id := range moduleIDs {
		indegree[id] = 0
		outgoing[id] = map[string]struct{}{}
	}

	for _, moduleInfo := range modules {
		for _, edge := range collectModuleEdges(moduleInfo, moduleSet) {
			fromSet, ok := outgoing[edge[0]]
			if !ok {
				continue
			}
			if _, seen := fromSet[edge[1]]; seen {
				continue
			}
			fromSet[edge[1]] = struct{}{}
			indegree[edge[1]]++
		}
	}

	queue := make([]string, 0, len(moduleIDs))
	for _, id := range moduleIDs {
		if indegree[id] == 0 {
			queue = append(queue, id)
		}
	}
	sortByModuleOrder(modules, queue)

	ordered := make([]string, 0, len(moduleIDs))
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		ordered = append(ordered, current)

		next := make([]string, 0, len(outgoing[current]))
		for target := range outgoing[current] {
			next = append(next, target)
		}
		for _, target := range next {
			indegree[target]--
			if indegree[target] == 0 {
				queue = append(queue, target)
			}
		}

		sortByModuleOrder(modules, queue)
	}

	orderedSet := map[string]struct{}{}
	for _, id := range ordered {
		orderedSet[id] = struct{}{}
	}
	unresolved := make([]string, 0, 4)
	for _, id := range moduleIDs {
		if _, ok := orderedSet[id]; !ok {
			unresolved = append(unresolved, id)
		}
	}

	return LoadOrder{
		OrderedModuleIDs:    ordered,
		CycleDetected:       len(unresolved) > 0,
		UnresolvedModuleIDs: unresolved,
	}
}

// sortByModuleOrder sorts in place with compareModuleOrder. It is a stable insertion sort because the
// lists are small and the comparator is a full scan of `modules` per call — an O(n log n) sort with
// this comparator would be slower than the sort it replaces.
func sortByModuleOrder(modules []ModuleInfo, ids []string) {
	for i := 1; i < len(ids); i++ {
		for j := i; j > 0 && compareModuleOrder(modules, ids[j], ids[j-1]) < 0; j-- {
			ids[j], ids[j-1] = ids[j-1], ids[j]
		}
	}
}

// compareModuleOrder mirrors compareModuleOrder: OFFICIAL MODULES FIRST, then by module id.
//
// ★ THE SIGN CONVENTION IS THE WHOLE FUNCTION, AND THE FIRST VERSION OF THIS PORT HAD IT BACKWARDS.
// The TypeScript returns `Number(right.isOfficial) - Number(left.isOfficial)`, so an official LEFT
// and a community RIGHT yield -1 — and the sort contract reads a negative as "left comes first".
// Officials therefore sort EARLIER. Reading the subtraction as "prefer the right-hand official" (as
// the first version here did) reverses the recommended load order for every install that has both
// kinds of module, which is every install. The differential caught it on a two-module case.
//
// ★ AN UNKNOWN ID FALLS BACK TO A PLAIN COMPARISON, and the fallback applies when EITHER side is
// missing, so no panic and no partial ordering.
//
// ★ AN UNKNOWN ID FALLS BACK TO A PLAIN COMPARISON, and the fallback applies when EITHER side is
// missing, so no panic and no partial ordering.
func compareModuleOrder(modules []ModuleInfo, leftID, rightID string) int {
	left, hasLeft := findModule(modules, leftID)
	right, hasRight := findModule(modules, rightID)
	if !hasLeft || !hasRight {
		return report.CompareCodeUnits(leftID, rightID)
	}

	if left.IsOfficial != right.IsOfficial {
		if left.IsOfficial {
			// An official LEFT sorts earlier: `Number(right.isOfficial) - Number(left.isOfficial)` is
			// negative exactly when left is the official one, and the sort contract is "negative means
			// left comes first".
			return -1
		}
		return 1
	}
	return report.CompareCodeUnits(left.ModuleID, right.ModuleID)
}

// findModule mirrors `modules.find(...)`: the FIRST match wins, which matters when two modules
// declare the same id (a case the doctor reports as `duplicate_module_id` and which therefore
// reaches this function).
func findModule(modules []ModuleInfo, id string) (ModuleInfo, bool) {
	for _, m := range modules {
		if m.ModuleID == id {
			return m, true
		}
	}
	return ModuleInfo{}, false
}

// collectModuleEdges mirrors collectModuleEdges: four sources of edges, in this order.
//
// ★ THE DIRECTIONS ARE NOT UNIFORM, AND THAT IS WHERE THE ARITHMETIC IS EASY TO GET WRONG:
//
//	declared dependency          -> [dependency -> this]      (the dependency loads first)
//	metadata order LoadBeforeThis -> [metadata target, this]  (same direction as a dependency)
//	loadAfter                    -> [this -> target]          (this loads first)
//	metadata order LoadAfterThis  -> [this, metadata target]  (same direction as loadAfter)
//
// So `LoadBeforeThis` points INWARD and `LoadAfterThis` points OUTWARD, and both come from the same
// metadata list. Swapping either pair reverses a load order without failing anything.
//
// ★ A TARGET THAT IS NOT INSTALLED IS SIMPLY SKIPPED, which is what makes a missing dependency a
// reported issue rather than a broken edge.
func collectModuleEdges(moduleInfo ModuleInfo, moduleSet map[string]struct{}) [][2]string {
	edges := make([][2]string, 0, len(moduleInfo.Dependencies))

	for _, dependencyID := range moduleInfo.Dependencies {
		if _, ok := moduleSet[dependencyID]; ok {
			edges = append(edges, [2]string{dependencyID, moduleInfo.ModuleID})
		}
	}

	for _, meta := range moduleInfo.DepMetadata {
		if _, ok := moduleSet[meta.ModuleID]; !ok {
			continue
		}
		if meta.HasOrder && meta.Order == "LoadBeforeThis" {
			edges = append(edges, [2]string{meta.ModuleID, moduleInfo.ModuleID})
		}
	}

	for _, targetID := range moduleInfo.LoadAfter {
		if _, ok := moduleSet[targetID]; ok {
			edges = append(edges, [2]string{moduleInfo.ModuleID, targetID})
		}
	}

	for _, meta := range moduleInfo.DepMetadata {
		if _, ok := moduleSet[meta.ModuleID]; !ok {
			continue
		}
		if meta.HasOrder && meta.Order == "LoadAfterThis" {
			edges = append(edges, [2]string{moduleInfo.ModuleID, meta.ModuleID})
		}
	}

	return edges
}

// resolveLike mirrors Node's `path.resolve` for a single argument: it makes the path ABSOLUTE
// against the process working directory and collapses `.` and `..`.
//
// ★ IT DOES NOT LOWERCASE. The obvious shortcut — compare the two paths case-insensitively — would
// make the comparison succeed on inputs the original rejects, and the original's `===` is a strict
// string equality on the resolved strings. Case-insensitive filesystems are a fact about the DISK,
// not about path.resolve, so the folding is deliberately absent and the differential pins the
// strict form.
func resolveLike(path string) string {
	if path == "" {
		return path
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return filepath.ToSlash(filepath.Clean(path))
	}
	return filepath.ToSlash(abs)
}
