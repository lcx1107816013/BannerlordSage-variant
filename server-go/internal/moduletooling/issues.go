package moduletooling

import (
	"strings"

	"blore/internal/report"
)

// CollectDoctorIssues mirrors collectDoctorIssues: every issue `bannerlord_doctor` reports.
//
// ★ THE ISSUE ORDER IS PART OF THE OUTPUT. The function appends in a fixed sequence — duplicates
// per module id first, then a per-module block (missing dependencies, missing metadata targets,
// present incompatibles, then submodule problems, then shipped TaleWorlds DLLs), then the shared
// dependency passes. A caller renders them in that order, so the port must not sort or group them.
//
// ★ THE SEVERITIES ARE NOT A SCALE, THEY ARE PER-CHECK. A missing DLL is a WARNING while a missing
// DLLName is an ERROR, because an absent DLL can be a packaging choice while an entry that names no
// DLL cannot load at all. Each check's severity is reproduced from the source; none is inferred.
func CollectDoctorIssues(modules []ModuleInfo) []Issue {
	issues := make([]Issue, 0, 16)

	// Group by module id, preserving first-seen order of the ids and of each group's members, so the
	// duplicate report lists modules in the order they were loaded.
	order := make([]string, 0, len(modules))
	modulesByID := map[string][]ModuleInfo{}
	for _, m := range modules {
		if _, seen := modulesByID[m.ModuleID]; !seen {
			order = append(order, m.ModuleID)
		}
		modulesByID[m.ModuleID] = append(modulesByID[m.ModuleID], m)
	}

	for _, moduleID := range order {
		duplicates := modulesByID[moduleID]
		if len(duplicates) <= 1 {
			continue
		}
		for _, duplicate := range duplicates {
			issues = append(issues, Issue{
				Severity:    "error",
				IssueType:   "duplicate_module_id",
				ModuleID:    moduleID,
				HasModuleID: true,
				FilePath:    duplicate.SubModulePath,
				HasFilePath: true,
				Detail: "Multiple modules declare the same module id '" + moduleID +
					"'. Bannerlord load order and dependency resolution will be ambiguous.",
			})
		}
	}

	for _, moduleInfo := range modules {
		for _, dependencyID := range moduleInfo.Dependencies {
			if _, installed := modulesByID[dependencyID]; !installed {
				issues = append(issues, Issue{
					Severity:        "error",
					IssueType:       "missing_dependency",
					ModuleID:        moduleInfo.ModuleID,
					HasModuleID:     true,
					RelatedModuleID: dependencyID,
					HasRelated:      true,
					FilePath:        moduleInfo.SubModulePath,
					HasFilePath:     true,
					Detail: "Declared dependency '" + dependencyID +
						"' was not found under the Bannerlord Modules directory.",
				})
			}
		}

		for _, metadata := range moduleInfo.DepMetadata {
			_, installed := modulesByID[metadata.ModuleID]
			if !installed && !metadata.Optional {
				issues = append(issues, Issue{
					Severity:        "warning",
					IssueType:       "missing_dependency_metadata_target",
					ModuleID:        moduleInfo.ModuleID,
					HasModuleID:     true,
					RelatedModuleID: metadata.ModuleID,
					HasRelated:      true,
					FilePath:        moduleInfo.SubModulePath,
					HasFilePath:     true,
					Detail: "Community dependency metadata references '" + metadata.ModuleID +
						"', but no installed module with that id was found.",
				})
			}
		}

		for _, incompatibleID := range moduleInfo.Incompatible {
			if _, installed := modulesByID[incompatibleID]; installed {
				issues = append(issues, Issue{
					Severity:        "warning",
					IssueType:       "incompatible_module_present",
					ModuleID:        moduleInfo.ModuleID,
					HasModuleID:     true,
					RelatedModuleID: incompatibleID,
					HasRelated:      true,
					FilePath:        moduleInfo.SubModulePath,
					HasFilePath:     true,
					Detail: "Module '" + moduleInfo.ModuleID + "' marks '" + incompatibleID +
						"' as incompatible, but that module is installed.",
				})
			}
		}

		for _, subModule := range moduleInfo.SubModules {
			if !subModule.HasDLLName || subModule.DLLName == "" {
				issues = append(issues, Issue{
					Severity:    "error",
					IssueType:   "missing_submodule_dll_name",
					ModuleID:    moduleInfo.ModuleID,
					HasModuleID: true,
					FilePath:    moduleInfo.SubModulePath,
					HasFilePath: true,
					Detail: "A SubModule entry in '" + moduleInfo.ModuleID +
						"' does not declare DLLName.",
				})
				// ★ THE `continue` IS LOAD-BEARING: an entry with no DLL name is not ALSO checked for
				// a class type or for the DLL's presence, because both of those checks are about a
				// named DLL. Removing it would emit a second issue for the same entry.
				continue
			}

			if !subModule.HasClass || subModule.ClassType == "" {
				issues = append(issues, Issue{
					Severity:    "error",
					IssueType:   "missing_submodule_class_type",
					ModuleID:    moduleInfo.ModuleID,
					HasModuleID: true,
					FilePath:    moduleInfo.SubModulePath,
					HasFilePath: true,
					DLLName:     subModule.DLLName,
					HasDLL:      true,
					Detail: "SubModule '" + subModule.DLLName +
						"' does not declare SubModuleClassType.",
				})
			}

			if !hasDLLNamed(moduleInfo.DLLFiles, subModule.DLLName) {
				issues = append(issues, Issue{
					Severity:    "warning",
					IssueType:   "missing_declared_submodule_dll",
					ModuleID:    moduleInfo.ModuleID,
					HasModuleID: true,
					FilePath:    moduleInfo.SubModulePath,
					HasFilePath: true,
					DLLName:     subModule.DLLName,
					HasDLL:      true,
					Detail: "SubModule '" + subModule.DLLName +
						"' is declared in SubModule.xml but no matching DLL was found under the " +
						"module bin directories.",
				})
			}
		}

		if !moduleInfo.IsOfficial {
			for _, dll := range moduleInfo.DLLFiles {
				if strings.HasPrefix(dll.FileName, "TaleWorlds.") {
					issues = append(issues, Issue{
						Severity:    "warning",
						IssueType:   "ships_official_taleworlds_dll",
						ModuleID:    moduleInfo.ModuleID,
						HasModuleID: true,
						FilePath:    joinPath(moduleInfo.ModuleDir, dll.RelativePath),
						HasFilePath: true,
						DLLName:     dll.FileName,
						HasDLL:      true,
						Detail: "Module '" + moduleInfo.ModuleID + "' ships '" + dll.FileName +
							"'. Bundling TaleWorlds assemblies inside a community module often " +
							"causes version drift and hard-to-debug crashes.",
					})
				}
			}
		}
	}

	// ── the shared-dependency passes ───────────────────────────────────────────
	//
	// ★ THESE RUN OVER THE WHOLE INSTALL, NOT PER MODULE, and they are why the function needs every
	// module's DLL list at once. Only NON-OFFICIAL modules participate: a TaleWorlds module shipping
	// its own assemblies is normal, and the entire check exists for community bundles.
	//
	// ★ THE GROUP KEY IS THE LOWERCASED FILE NAME, so `0Harmony.dll` and `0harmony.dll` land in one
	// group. Group order is first-seen, which is what makes the output stable across runs.
	groupOrder := make([]string, 0, 8)
	sharedGroups := map[string][]sharedEntry{}

	for _, moduleInfo := range modules {
		if moduleInfo.IsOfficial {
			continue
		}
		for _, dll := range moduleInfo.DLLFiles {
			lowerName := strings.ToLower(dll.FileName)
			canonicalModuleID, isShared := sharedDependencyDLLToModule[lowerName]
			if !isShared {
				continue
			}

			if _, seen := sharedGroups[lowerName]; !seen {
				groupOrder = append(groupOrder, lowerName)
			}
			sharedGroups[lowerName] = append(sharedGroups[lowerName], sharedEntry{
				ModuleID: moduleInfo.ModuleID,
				FilePath: joinPath(moduleInfo.ModuleDir, dll.RelativePath),
				MD5:      dll.MD5,
				HasMD5:   dll.HasMD5,
			})

			if moduleInfo.ModuleID != canonicalModuleID {
				issues = append(issues, Issue{
					Severity:        "warning",
					IssueType:       "bundled_shared_dependency",
					ModuleID:        moduleInfo.ModuleID,
					HasModuleID:     true,
					RelatedModuleID: canonicalModuleID,
					HasRelated:      true,
					FilePath:        joinPath(moduleInfo.ModuleDir, dll.RelativePath),
					HasFilePath:     true,
					DLLName:         dll.FileName,
					HasDLL:          true,
					Detail: "Module '" + moduleInfo.ModuleID + "' bundles shared dependency '" +
						dll.FileName + "'. Prefer declaring '" + canonicalModuleID +
						"' as a dependency instead of shipping a private copy.",
				})
			}
		}
	}

	for _, lowerName := range groupOrder {
		entries := sharedGroups[lowerName]
		// ★ THE HASH KEY FALLS BACK TO `moduleId:filePath` WHEN THE MD5 IS ABSENT, so two entries
		// with unhashed DLLs are treated as DIFFERENT variants whenever they come from different
		// places. That is the original's expression, and it means a missing MD5 never collapses a
		// conflict — it can only create one.
		uniqueHashes := map[string]struct{}{}
		for _, entry := range entries {
			key := entry.ModuleID + ":" + entry.FilePath
			if entry.HasMD5 && entry.MD5 != "" {
				key = entry.MD5
			}
			uniqueHashes[key] = struct{}{}
		}

		if len(entries) > 1 && len(uniqueHashes) > 1 {
			canonicalModuleID, ok := sharedDependencyDLLToModule[lowerName]
			if !ok {
				canonicalModuleID = "unknown"
			}
			for _, entry := range entries {
				issues = append(issues, Issue{
					Severity:        "error",
					IssueType:       "conflicting_shared_dependency_variants",
					ModuleID:        entry.ModuleID,
					HasModuleID:     true,
					RelatedModuleID: canonicalModuleID,
					HasRelated:      true,
					FilePath:        entry.FilePath,
					HasFilePath:     true,
					DLLName:         lowerName,
					HasDLL:          true,
					Detail: "Multiple modules ship different variants of '" + lowerName +
						"'. This usually produces loader conflicts or runtime patch instability.",
				})
			}
		}
	}

	return issues
}

type sharedEntry struct {
	ModuleID string
	FilePath string
	MD5      string
	HasMD5   bool
}

// hasDLLNamed mirrors `dllFiles.some(dll => dll.fileName.toLowerCase() === subModule.dllName!.toLowerCase())`:
// a CASE-INSENSITIVE file-name equality, not a path comparison.
//
// ★ IT COMPARES THE BASE NAME ONLY, so a DLL in any bin subdirectory satisfies the declaration —
// which is the point, since the scan deliberately walks nested bin directories.
func hasDLLNamed(dlls []DLLInfo, want string) bool {
	wantLower := strings.ToLower(want)
	for _, dll := range dlls {
		if strings.ToLower(dll.FileName) == wantLower {
			return true
		}
	}
	return false
}

// joinPath mirrors `join(moduleDir, relativePath)`.
//
// The relative path was recorded with FORWARD slashes by the scanner; filepath.Join on Windows would
// accept them, but the result is compared as a STRING by callers, so the separators are normalised to
// forward slashes to match what the original produces on every platform.
func joinPath(dir, relative string) string {
	if relative == "" {
		return dir
	}
	return strings.TrimSuffix(strings.ReplaceAll(dir, "\\", "/"), "/") + "/" + relative
}

// TrimRef is the JS trim used by the focus selection; it lives here as a one-line alias so the
// selection's two call sites read the same way they do in the original.
func TrimRef(value string) string {
	return report.TrimJS(value)
}
