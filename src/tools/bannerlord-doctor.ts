// Scans a live Bannerlord install for module health problems: dependency
// cycles, duplicate shared DLLs, declared-but-missing SubModule DLLs, and
// load-order conflicts. Reports a recommended load order plus per-module
// details for the focused set.
import { AiTextBlock, renderAiTextReport } from '../utils/ai-text'
import {
  buildRecommendedLoadOrder,
  collectDoctorIssues,
  computeDoctorFocusModules,
  loadBannerlordModules,
  resolveBannerlordDoctorGameDir,
} from '../utils/bannerlord-module-tooling'

/**
 * Community framework DLLs are normal to find in several modules at once; only
 * non-framework duplicates should raise flags. Listed in lowercase because the
 * comparison is case-insensitive — module authors capitalise these freely.
 */
const SHARED_DEPENDENCY_DLLS = new Set([
  '0harmony.dll',
  'bannerlord.blse.shared.dll',
  'bannerlord.butterlib.dll',
  'bannerlord.mboptionscreen.dll',
  'bannerlord.moduleloader.bannerlord.mboptionscreen.dll',
  'bannerlord.uiextenderex.dll',
])

/** The note attached to the cycle block when the module graph is not sortable. */
const CYCLE_DETAIL =
  'The module graph contains a cycle. At least one dependency or load-after rule conflicts with another declared ordering rule.'

export async function bannerlordDoctor(
  gameDir?: string,
  moduleId?: string,
  modulePath?: string,
  includeOfficialDetails = false
) {
  const resolvedGameDir = await resolveBannerlordDoctorGameDir(gameDir)
  const modules = await loadBannerlordModules(resolvedGameDir)
  if (modules.length === 0) {
    return oneText(`No Bannerlord modules with SubModule.xml were found under: ${resolvedGameDir}`)
  }

  const focusedModules = computeDoctorFocusModules(modules, moduleId, modulePath)
  if (focusedModules.length === 0) {
    return oneText(
      `No Bannerlord module matched moduleId='${moduleId || ''}' modulePath='${modulePath || ''}'.`
    )
  }

  const loadOrder = buildRecommendedLoadOrder(modules)
  const allIssues = await collectDoctorIssues(modules)

  // Keep issues that concern the focused modules directly, or that have no
  // module attribution at all (install-wide findings).
  const focusedIds = new Set(focusedModules.map(moduleInfo => moduleInfo.moduleId))
  const issues = allIssues.filter(issue => concernsFocus(issue, focusedIds))

  const nonOfficialCount = modules.filter(moduleInfo => !moduleInfo.isOfficial).length
  const blocks: AiTextBlock[] = [
    {
      header: 'doctor_summary',
      fields: [
        { key: 'game_dir', value: resolvedGameDir },
        { key: 'modules_scanned', value: modules.length },
        { key: 'focused_modules', value: focusedModules.length },
        { key: 'non_official_modules_scanned', value: nonOfficialCount },
        { key: 'issue_count', value: issues.length },
        { key: 'cycle_detected', value: loadOrder.cycleDetected },
      ],
      listFields: [
        { key: 'focused_module_ids', values: focusedModules.map(moduleInfo => moduleInfo.moduleId) },
        { key: 'recommended_load_order', values: loadOrder.orderedModuleIds },
        { key: 'unresolved_cycle_module_ids', values: loadOrder.unresolvedModuleIds },
      ],
    },
  ]

  for (const moduleInfo of focusedModules) {
    // Official modules are only detailed when asked for, or when the caller
    // focused on a single one — otherwise they are summary-only noise.
    const isSkippableOfficial = !includeOfficialDetails && moduleInfo.isOfficial && focusedModules.length > 1
    if (isSkippableOfficial) {
      continue
    }

    blocks.push(buildModuleBlock(moduleInfo))
  }

  if (loadOrder.cycleDetected) {
    blocks.push({
      header: 'load_order_cycle',
      fields: [
        { key: 'severity', value: 'error' },
        { key: 'issue_type', value: 'load_order_cycle_detected' },
      ],
      listFields: [{ key: 'unresolved_module_ids', values: loadOrder.unresolvedModuleIds }],
      multilineFields: [{ key: 'detail', value: CYCLE_DETAIL }],
    })
  }

  for (const issue of issues) {
    blocks.push({
      header: `${issue.severity}_${issue.issueType}`,
      fields: [
        { key: 'severity', value: issue.severity },
        { key: 'issue_type', value: issue.issueType },
        { key: 'module_id', value: issue.moduleId },
        { key: 'related_module_id', value: issue.relatedModuleId },
        { key: 'file_path', value: issue.filePath },
        { key: 'dll_name', value: issue.dllName },
      ],
      multilineFields: [{ key: 'detail', value: issue.detail }],
    })
  }

  const report = renderAiTextReport(
    'bannerlord_doctor',
    'doctor_target',
    moduleId || modulePath || 'auto_non_official_modules',
    blocks
  )

  return oneText(report)
}

/** Wraps a rendered report in the single-text-content reply shape. */
function oneText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * An issue belongs to the report when it is unattributed (install-wide), names a
 * focused module outright, or names one as its related module.
 */
function concernsFocus(
  issue: { moduleId: string | null; relatedModuleId: string | null },
  focusedIds: Set<string>
): boolean {
  if (!issue.moduleId) {
    return true
  }
  if (focusedIds.has(issue.moduleId)) {
    return true
  }
  return issue.relatedModuleId != null && focusedIds.has(issue.relatedModuleId)
}

/** One module's detail block: identity, declared graph edges, and its DLL facts. */
function buildModuleBlock(moduleInfo: {
  moduleId: string
  moduleName: string
  version: string | null
  moduleType: string | null
  moduleCategory: string | null
  isOfficial: boolean
  subModulePath: string
  moduleDir: string
  subModules: Array<{ dllName: string | null }>
  dllFiles: Array<{ fileName: string; relativePath: string }>
  dependencies: string[]
  loadAfter: string[]
  incompatible: string[]
  dependencyMetadata: Array<{ moduleId: string; order: string | null; optional: boolean; version: string | null }>
}): AiTextBlock {
  return {
    header: `module_${moduleInfo.moduleId}`,
    fields: [
      { key: 'module_id', value: moduleInfo.moduleId },
      { key: 'module_name', value: moduleInfo.moduleName },
      { key: 'version', value: moduleInfo.version },
      { key: 'module_type', value: moduleInfo.moduleType },
      { key: 'module_category', value: moduleInfo.moduleCategory },
      { key: 'is_official', value: moduleInfo.isOfficial },
      { key: 'submodule_xml_path', value: moduleInfo.subModulePath },
      { key: 'module_dir', value: moduleInfo.moduleDir },
      { key: 'submodule_count', value: moduleInfo.subModules.length },
      { key: 'dll_count', value: moduleInfo.dllFiles.length },
    ],
    listFields: [
      { key: 'declared_dependencies', values: moduleInfo.dependencies },
      { key: 'load_after_targets', values: moduleInfo.loadAfter },
      { key: 'incompatible_modules', values: moduleInfo.incompatible },
      {
        key: 'dependency_metadata',
        values: moduleInfo.dependencyMetadata.map(renderDependencyMetadata),
      },
      {
        key: 'declared_submodule_dlls',
        values: moduleInfo.subModules
          .map(subModule => subModule.dllName)
          .filter((value): value is string => Boolean(value)),
      },
      {
        key: 'shared_dependency_dlls',
        values: moduleInfo.dllFiles
          .filter(dll => isSharedDependencyDll(dll.fileName))
          .map(dll => `${dll.fileName} (${dll.relativePath})`),
      },
    ],
  }
}

/** `id:order[:optional][:version]`, with an absent order rendering as "unknown". */
function renderDependencyMetadata(item: {
  moduleId: string
  order: string | null
  optional: boolean
  version: string | null
}): string {
  const order = item.order || 'unknown'
  const optionalSuffix = item.optional ? ':optional' : ''
  const versionSuffix = item.version ? `:${item.version}` : ''
  return `${item.moduleId}:${order}${optionalSuffix}${versionSuffix}`
}

/** True for the framework DLLs that legitimately appear in several modules. */
function isSharedDependencyDll(fileName: string): boolean {
  return SHARED_DEPENDENCY_DLLS.has(fileName.toLowerCase())
}
