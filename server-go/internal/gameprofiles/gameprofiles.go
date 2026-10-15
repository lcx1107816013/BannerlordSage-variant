// Package gameprofiles ports src/utils/game-profiles.ts: it describes the supported game
// installations and answers the questions the indexer asks about one.
//
// ★ WHAT IS PORTED, AND WHAT IS NOT.
//
// Ported here, because they are pure functions over data and can be differentially tested:
//   - the official-module classification (allowlist, ModuleType, the Official flag) and the
//     sort order it produces
//   - the DLL candidate scoring, dedupe, sort and selection
//   - the root-bin DLL predicates, including the denylist and the modding excludes
//   - the XML collection decision (which modules are included vs skipped) given classifications
//
// NOT ported here, and deliberately: detection of the INSTALL directory. The TypeScript reaches
// into the Windows registry, parses Steam's libraryfolders.vdf and appmanifest_*.acf, and probes
// every drive letter. That work is environment discovery, not behaviour other code depends on —
// and this project's ledger already records that a probe of that kind can report a confident
// answer about a machine it cannot see. The Go side takes the game directory as an INPUT, exactly
// as the tools layer already does (`resolveBannerlordDoctorGameDir`). The package comment records
// the omission rather than shipping a half-tested detector.
//
// ★ THE WALKER IS ALSO NOT HERE, ON PURPOSE. walkFiles in the TypeScript carries a measured fix
// for Vortex-style installs, where the DVCS dirent of a symlinked DLL reports isFile() == false
// and 110 of 111 entries in one directory were symlinks (ledger: 39 false
// missing_declared_submodule_dll alarms before the fix). That fix lives with the doctor's own
// walk in internal/mods, and duplicating it here would create a second copy to keep in step —
// the exact shape F25 records for the sibling repository.
package gameprofiles

import (
	"sort"
	"strings"

	"blore/internal/report"
)

// XmlImportScope mirrors XmlImportScope.
type XmlImportScope = string

// DllImportScope mirrors DllImportScope.
type DllImportScope = string

// XmlModuleClassification mirrors XmlModuleClassification.
type XmlModuleClassification struct {
	ModuleName               string
	ModuleID                 string
	ModuleType               string // "" when the element is absent
	OfficialFlag             *bool  // nil when the attribute is absent, which is NOT the same as false
	MetadataSuggestsOfficial bool
	IsOfficial               bool
	Reason                   string
	ModuleDir                string
}

// OfficialModuleIDs mirrors BANNERLORD_OFFICIAL_MODULE_IDS.
//
// ★ IT IS AN ALLOWLIST, NOT THE CLASSIFICATION RULE. A module is official when its DIRECTORY name
// or its declared Id is in this set; the `ModuleType` and `Official` elements are recorded and
// reported but do NOT decide `isOfficial`. That asymmetry is the original's and is preserved —
// `metadataSuggestsOfficial` exists precisely so a reader can see the metadata disagreed.
var OfficialModuleIDs = map[string]bool{
	"Native":        true,
	"SandBoxCore":   true,
	"Sandbox":       true,
	"SandBox":       true,
	"StoryMode":     true,
	"CustomBattle":  true,
	"BirthAndDeath": true,
	"FastMode":      true,
	"Multiplayer":   true,
	"NavalDLC":      true,
}

// RootBinDLLPrefixes mirrors BANNERLORD_ROOT_BIN_DLL_PREFIXES.
var RootBinDLLPrefixes = []string{
	"TaleWorlds.",
	"SandBox",
	"StoryMode",
	"CustomBattle",
	"NavalDLC",
}

// RootBinDLLDenylist mirrors BANNERLORD_ROOT_BIN_DLL_DENYLIST. Stored lowercased, as the original
// builds it with `.map(name => name.toLowerCase())`.
var RootBinDLLDenylist = map[string]bool{
	"bannerlord.blse.shared.dll": true,
	"taleworlds.native.dll":      true,
}

// ModdingSupportDLLs mirrors BANNERLORD_MODDING_SUPPORT_DLLS (already lowercased by the original).
var ModdingSupportDLLs = map[string]bool{
	"newtonsoft.json.dll":         true,
	"steamworks.net.dll":          true,
	"stbsharp.dll":                true,
	"system.management.dll":       true,
	"system.numerics.vectors.dll": true,
}

// coreDLLInputs mirrors BANNERLORD_CORE_DLL_INPUTS.
var coreDLLInputs = []string{
	"TaleWorlds.CampaignSystem.dll",
	"TaleWorlds.Core.dll",
	"TaleWorlds.Engine.dll",
	"TaleWorlds.GauntletUI.dll",
	"TaleWorlds.GauntletUI.Data.dll",
	"TaleWorlds.Library.dll",
	"TaleWorlds.Localization.dll",
	"TaleWorlds.MountAndBlade.dll",
	"TaleWorlds.ObjectSystem.dll",
	"TaleWorlds.ScreenSystem.dll",
	"Modules/SandBox/bin/Win64_Shipping_Client/SandBox.dll",
	"Modules/StoryMode/bin/Win64_Shipping_Client/StoryMode.dll",
	"Modules/CustomBattle/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.CustomBattle.dll",
	"Modules/Multiplayer/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.Multiplayer.dll",
	"Modules/NavalDLC/bin/Win64_Shipping_Client/NavalDLC.dll",
	"Modules/Native/bin/Win64_Shipping_Client/TaleWorlds.MountAndBlade.View.dll",
}

// CoreDLLInputs returns a copy of the requested core DLL list.
func CoreDLLInputs() []string {
	out := make([]string, len(coreDLLInputs))
	copy(out, coreDLLInputs)
	return out
}

// ScoreDLLPath mirrors scoreDllPath.
//
// ★ THE FOUR BANDS ARE NOT A RANKING OF "BETTER DLL", they are a ranking of WHERE IT SITS:
// 100 root bin under Win64_Shipping_Client, 80 a MODULE's bin under Win64_Shipping_Client,
// 70 root bin elsewhere, 60 a module's bin elsewhere, 10 anything else. The first match wins, so
// the order of the two checks matters: a path under /bin/win64_shipping_client/ never reaches the
// /bin/ branch.
func ScoreDLLPath(dllPath string) int {
	normalized := strings.ToLower(strings.ReplaceAll(dllPath, `\`, "/"))

	if strings.Contains(normalized, "/bin/win64_shipping_client/") {
		if strings.Contains(normalized, "/modules/") {
			return 80
		}
		return 100
	}

	if strings.Contains(normalized, "/bin/") {
		if strings.Contains(normalized, "/modules/") {
			return 60
		}
		return 70
	}

	return 10
}

// IsOfficialRootBinDLL mirrors isBannerlordOfficialRootBinDll.
//
// The denylist is checked FIRST, so a name that both matches a prefix and is denied stays denied.
func IsOfficialRootBinDLL(filePath string) bool {
	fileName := strings.ToLower(baseName(filePath))
	if RootBinDLLDenylist[fileName] {
		return false
	}
	for _, prefix := range RootBinDLLPrefixes {
		if strings.HasPrefix(fileName, strings.ToLower(prefix)) {
			return true
		}
	}
	return false
}

// IsModdingRootBinDLL mirrors isBannerlordModdingRootBinDll.
//
// ★ A SUPPORT DLL IS ACCEPTED BEFORE THE OFFICIAL TEST. Newtonsoft.Json.dll and its siblings are
// NOT official-prefixed, so the early `true` is what lets them through — reordering these two
// checks would silently drop every one of them.
func IsModdingRootBinDLL(filePath string) bool {
	fileName := strings.ToLower(baseName(filePath))
	if ModdingSupportDLLs[fileName] {
		return true
	}
	if !IsOfficialRootBinDLL(filePath) {
		return false
	}
	for _, re := range moddingRootBinExcludes {
		if re.MatchString(fileName) {
			return false
		}
	}
	return true
}

// SortDLLCandidates mirrors sortBannerlordDllCandidates: resolve, DEDUPE, then score DESC with a
// localeCompare tie-break.
//
// ★ THE DEDUPE HAPPENS BEFORE THE SORT and is by the resolved path, so two spellings of one file
// collapse. The tie-break is report.CompareCodeUnits rather than localeCompare — the same
// DECLARED DEVIATION the report and gauntlet-ui ports carry, and for the same measured reason
// (localeCompare resolves against the host's locale and disagrees with code-unit order on case,
// punctuation and accent: measured 22 of 40 crafted pairs on this machine).
func SortDLLCandidates(paths []string, resolve func(string) string) []string {
	seen := make(map[string]bool, len(paths))
	unique := make([]string, 0, len(paths))
	for _, p := range paths {
		r := resolve(p)
		if seen[r] {
			continue
		}
		seen[r] = true
		unique = append(unique, r)
	}

	sort.SliceStable(unique, func(i, j int) bool {
		si, sj := ScoreDLLPath(unique[i]), ScoreDLLPath(unique[j])
		if si != sj {
			return si > sj
		}
		return report.CompareCodeUnits(unique[i], unique[j]) < 0
	})
	return unique
}

// SelectDLLCandidates mirrors selectBannerlordDllCandidates.
//
// ★ TWO LOOKUP STRATEGIES, IN THIS ORDER, and each entry falls back independently:
//  1. if the request contains a `/` AND the normalised relative path matches exactly, that wins;
//     a request WITHOUT a slash never uses this map even if a key would match.
//  2. otherwise the request is matched by BASENAME, and when several candidates share a basename
//     the highest-scoring one is taken.
//
// The leading `./` is stripped before the relative lookup, and the whole comparison is
// case-insensitive. A request that matches nothing is DROPPED silently — the result can be
// shorter than the request list, which is intended.
func SelectDLLCandidates(
	gameDir string,
	candidateDLLs []string,
	requested []string,
	rel func(base, target string) string,
	baseNameFn func(string) string,
	resolve func(string) string,
) []string {
	relativeMap := make(map[string]string, len(candidateDLLs))
	basenameMap := make(map[string][]string, len(candidateDLLs))

	for _, dllPath := range candidateDLLs {
		relativePath := strings.ToLower(strings.ReplaceAll(rel(gameDir, dllPath), `\`, "/"))
		relativeMap[relativePath] = dllPath

		key := strings.ToLower(baseNameFn(dllPath))
		basenameMap[key] = append(basenameMap[key], dllPath)
	}

	resolved := make([]string, 0, len(requested))
	for _, item := range requested {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}

		normalizedRelative := strings.ToLower(stripLeadingDotSlash(strings.ReplaceAll(trimmed, `\`, "/")))
		if strings.Contains(normalizedRelative, "/") {
			if hit, ok := relativeMap[normalizedRelative]; ok {
				resolved = append(resolved, hit)
				continue
			}
		}

		if matches := basenameMap[strings.ToLower(baseNameFn(trimmed))]; len(matches) > 0 {
			resolved = append(resolved, SortDLLCandidates(matches, resolve)[0])
		}
	}

	return SortDLLCandidates(resolved, resolve)
}

// ClassifyModule mirrors the per-directory half of classifyBannerlordModules.
//
// The caller supplies the SubModule.xml contents (or "" when the file is absent) because reading it
// is filesystem work that belongs to the caller; everything below is the classification itself.
//
// ★ `OfficialFlag` DISTINGUISHES THREE STATES, and the port keeps all three: absent (the element
// is missing), present-but-not-"true", and present-and-"true". The TypeScript computes
// `officialFlagRaw == null ? null : trimmed === 'true'`, so a present-but-garbage value is `false`
// rather than nil. Collapsing absent into false would make `metadataSuggestsOfficial` wrong for
// exactly the modules whose metadata is incomplete.
//
// ★ THE REASON STRING IS A CONTRACT, not a log line: it is rendered into the doctor's report and
// carries the moduleType verbatim (`metadata-only:<moduleType>`), including its original casing
// and any surrounding spaces as they appeared between the tags.
func ClassifyModule(dirName, moduleIDOrEmpty, subModuleXML, moduleDir string) XmlModuleClassification {
	moduleID := moduleIDOrEmpty
	if moduleID == "" {
		moduleID = dirName
	}

	moduleTypeRaw := GetXMLValue(subModuleXML, "ModuleType")
	officialFlagRaw := GetXMLValue(subModuleXML, "Official")

	var officialFlag *bool
	if officialFlagRaw != nil {
		v := strings.ToLower(strings.TrimSpace(*officialFlagRaw)) == "true"
		officialFlag = &v
	}

	var normalizedModuleType *string
	if moduleTypeRaw != nil {
		v := strings.ToLower(strings.TrimSpace(*moduleTypeRaw))
		normalizedModuleType = &v
	}

	isOfficialByType := normalizedModuleType != nil &&
		(*normalizedModuleType == "official" || *normalizedModuleType == "officialoptional")
	isOfficialByFlag := officialFlag != nil && *officialFlag
	isOfficialByAllowlist := OfficialModuleIDs[dirName] || OfficialModuleIDs[moduleID]
	metadataSuggestsOfficial := isOfficialByType || isOfficialByFlag

	reason := "community-or-unknown"
	if isOfficialByAllowlist {
		reason = "official-allowlist"
	} else if isOfficialByType {
		reason = "metadata-only:" + derefOrEmpty(moduleTypeRaw)
	} else if isOfficialByFlag {
		reason = "metadata-only:official-flag:true"
	}

	out := XmlModuleClassification{
		ModuleName:               dirName,
		ModuleID:                 moduleID,
		OfficialFlag:             officialFlag,
		MetadataSuggestsOfficial: metadataSuggestsOfficial,
		IsOfficial:               isOfficialByAllowlist,
		Reason:                   reason,
		ModuleDir:                moduleDir,
	}
	if moduleTypeRaw != nil {
		out.ModuleType = *moduleTypeRaw
	}
	return out
}

// SortClassifications mirrors `results.sort((l, r) => l.moduleName.localeCompare(r.moduleName))`.
//
// ★ THIS IS THE SAME HOST-DEPENDENT CALL AS ELSEWHERE, so it carries the same declared deviation:
// report.CompareCodeUnits. For MODULE DIRECTORY NAMES the two orders agree on every ASCII name, so
// the practical difference is limited to names differing by case, punctuation or accent — which is
// why it is stated here rather than left implicit.
func SortClassifications(items []XmlModuleClassification) []XmlModuleClassification {
	out := make([]XmlModuleClassification, len(items))
	copy(out, items)
	sort.SliceStable(out, func(i, j int) bool {
		return report.CompareCodeUnits(out[i].ModuleName, out[j].ModuleName) < 0
	})
	return out
}

// CollectXMLFiles mirrors the decision half of collectXmlFiles: given the classifications, which
// modules contribute files and which are skipped. The file WALK itself is the caller's, because it
// is filesystem work with its own measured symlink rule.
func CollectXMLFiles(items []XmlModuleClassification, scope XmlImportScope) (included, skipped []XmlModuleClassification) {
	if scope == "all" {
		return append([]XmlModuleClassification{}, items...), []XmlModuleClassification{}
	}
	for _, item := range items {
		if item.IsOfficial {
			included = append(included, item)
		} else {
			skipped = append(skipped, item)
		}
	}
	return included, skipped
}

func derefOrEmpty(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
