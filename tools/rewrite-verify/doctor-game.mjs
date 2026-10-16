// Builds a synthetic Bannerlord game directory for the bannerlord-doctor differential.
//
// WHY SYNTHETIC: doctor scans a live install's `Modules/` tree. Using a real install would make
// the run depend on whatever that machine happens to have, and the corpus could not be
// committed. A crafted tree pins the branches instead — which is the whole point, because the
// tool has ELEVEN issue types and a corpus that trips only one of them proves almost nothing.
//
// ★ THE ELEMENT AND ATTRIBUTE NAMES BELOW ARE THE GAME'S, verified against
//   src/utils/bannerlord-module-tooling.ts rather than assumed:
//     Id/Name/Version/ModuleType/ModuleCategory  ->  <X value="..." />
//     DependedModules                            ->  <DependedModule Id="..." />
//     ModulesToLoadAfterThis                     ->  <ModulesToLoadAfterThis Id="..." />
//     IncompatibleModules                        ->  <IncompatibleModule Id="..." />
//     DependedModuleMetadatas                    ->  <DependedModuleMetadata id= order= optional= version= />
//                                                    (lowercase attributes here — a real quirk)
//     SubModules/SubModule                       ->  <SubModule><Name value= /><DLLName value= />
//                                                    <SubModuleClassType value= /></SubModule>
//   A first draft used plausible-looking wrong names and would have tripped almost nothing.
//
// ★ THE REQUIRED THREE ARE ALL PRESENT (the Lead named them explicitly):
//     duplicate_module_id             two Modules/ directories declaring the same ModuleId
//     missing_dependency              a declared dependency no module provides
//     missing_declared_submodule_dll  a SubModule declares a DLL absent from the bin dirs
//   and, so the report's other branches are not dead, also:
//     missing_submodule_dll_name, missing_submodule_class_type,
//     missing_dependency_metadata_target, incompatible_module_present,
//     ships_official_taleworlds_dll, bundled_shared_dependency,
//     conflicting_shared_dependency_variants, and a LOAD-ORDER CYCLE (CycleA loadAfter CycleB,
//     CycleB loadAfter CycleA) so `cycle_detected` and the `load_order_cycle` block both render.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './diffharness.mjs'

export const DOCTOR_ROOT = join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'doctor-game')

function writeModule(root, dirName, subModuleXml, dlls = []) {
  const moduleDir = join(root, 'Modules', dirName)
  mkdirSync(moduleDir, { recursive: true })

  if (dlls.length > 0) {
    // scanModuleDlls walks <moduleDir>/bin recursively, so the nested Shipping_Client
    // directory is representative and its relativePath is worth having in the fixture.
    const binDir = join(moduleDir, 'bin', 'Win64_Shipping_Client')
    mkdirSync(binDir, { recursive: true })
    for (const dll of dlls) {
      writeFileSync(join(binDir, dll), 'MZ synthetic dll for fixture use', 'utf8')
    }
  }

  writeFileSync(join(moduleDir, 'SubModule.xml'), subModuleXml, 'utf8')
}

/** Builds a SubModule.xml in the element shapes the loader actually reads. */
function subModuleXmlText({
  id,
  name,
  version = 'v1.0.0',
  type = 'Community',
  category = 'Other',
  deps = [],
  loadAfter = [],
  incompatible = [],
  depMeta = [],
  subModules = [],
}) {
  const depsXml = deps.length
    ? `\n  <DependedModules>\n${deps.map(d => `    <DependedModule Id="${d}" />`).join('\n')}\n  </DependedModules>`
    : ''
  const loadAfterXml = loadAfter.length
    ? `\n  <ModulesToLoadAfterThis>\n${loadAfter.map(d => `    <ModulesToLoadAfterThis Id="${d}" />`).join('\n')}\n  </ModulesToLoadAfterThis>`
    : ''
  const incompatibleXml = incompatible.length
    ? `\n  <IncompatibleModules>\n${incompatible.map(d => `    <IncompatibleModule Id="${d}" />`).join('\n')}\n  </IncompatibleModules>`
    : ''
  // Dependency metadata uses LOWERCASE attributes: id / order / optional / version.
  const metaXml = depMeta.length
    ? `\n  <DependedModuleMetadatas>\n${depMeta
        .map(m => {
          const order = m.order !== undefined ? ` order="${m.order}"` : ''
          const optional = m.optional !== undefined ? ` optional="${m.optional}"` : ''
          const metaVersion = m.version !== undefined ? ` version="${m.version}"` : ''
          return `    <DependedModuleMetadata id="${m.id}"${order}${optional}${metaVersion} />`
        })
        .join('\n')}\n  </DependedModuleMetadatas>`
    : ''

  const subXml = subModules.length
    ? `\n  <SubModules>\n${subModules
        .map(s => {
          const parts = [`<Name value="${s.name}" />`]
          if (s.dllName !== undefined) parts.push(`<DLLName value="${s.dllName}" />`)
          if (s.classType !== undefined) parts.push(`<SubModuleClassType value="${s.classType}" />`)
          return `    <SubModule>\n      ${parts.join('\n      ')}\n    </SubModule>`
        })
        .join('\n')}\n  </SubModules>`
    : ''

  return `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="${name}" />
  <Id value="${id}" />
  <Version value="${version}" />
  <ModuleType value="${type}" />
  <ModuleCategory value="${category}" />${depsXml}${loadAfterXml}${incompatibleXml}${metaXml}${subXml}
</Module>
`
}

export function buildDoctorGame() {
  rmSync(DOCTOR_ROOT, { recursive: true, force: true })
  mkdirSync(join(DOCTOR_ROOT, 'Modules'), { recursive: true })

  // ★ `looksLikeGameDir` (game-profiles.ts) requires BOTH Modules/ and bin/ to exist at the
  //   game root, and resolveBannerlordDoctorGameDir throws "Invalid ... game directory"
  //   without them. Without this the whole corpus is rejected before a single module loads.
  mkdirSync(join(DOCTOR_ROOT, 'bin', 'Win64_Shipping_Client'), { recursive: true })
  writeFileSync(
    join(DOCTOR_ROOT, 'bin', 'Win64_Shipping_Client', 'Version.xml'),
    '<?xml version="1.0" encoding="utf-8"?>\n<Version>\n  <Singleplayer value="v1.2.9" />\n</Version>\n',
    'utf8'
  )

  // ── an OFFICIAL module, so the official/non-official split and the
  //    `includeOfficialDetails` skip rule both have something to act on ──────
  writeModule(DOCTOR_ROOT, 'Native', subModuleXmlText({
    id: 'Native', name: 'Native', type: 'Official', category: 'Core',
    subModules: [{ name: 'Native', dllName: 'TaleWorlds.Native.dll', classType: 'TaleWorlds.Native.NativeSubModule' }],
  }), ['TaleWorlds.Native.dll'])

  writeModule(DOCTOR_ROOT, 'SandBox', subModuleXmlText({
    id: 'SandBox', name: 'SandBox', type: 'Official', category: 'Core',
    deps: ['Native'],
    subModules: [{ name: 'SandBox', dllName: 'TaleWorlds.SandBox.dll', classType: 'SandBox.SubModule' }],
  }), ['TaleWorlds.SandBox.dll', '0Harmony.dll'])

  // ── a HEALTHY community module ─────────────────────────────────────────────
  writeModule(DOCTOR_ROOT, 'HealthyMod', subModuleXmlText({
    id: 'HealthyMod', name: 'A Healthy Mod', type: 'Community', category: 'Other',
    deps: ['Native'],
    subModules: [{ name: 'HealthyMod', dllName: 'HealthyMod.dll', classType: 'HealthyMod.SubModule' }],
  }), ['HealthyMod.dll'])

  // ── ★ ISSUE: duplicate_module_id. A second directory declares 'HealthyMod'. ──
  writeModule(DOCTOR_ROOT, 'HealthyModCopy', subModuleXmlText({
    id: 'HealthyMod', name: 'A Healthy Mod (copy)', type: 'Community', category: 'Other',
    deps: ['Native'],
    subModules: [{ name: 'HealthyMod', dllName: 'HealthyMod.dll', classType: 'HealthyMod.SubModule' }],
  }), ['HealthyMod.dll'])

  // ── ★ ISSUE: missing_dependency. Depends on a module nobody ships. ─────────
  //    Also carries METADATA pointing at a module nobody ships, which is the separate
  //    missing_dependency_metadata_target issue.
  writeModule(DOCTOR_ROOT, 'BrokenDeps', subModuleXmlText({
    id: 'BrokenDeps', name: 'Broken Deps', type: 'Community', category: 'Other',
    deps: ['Native', 'NoSuchModuleAnywhere'],
    depMeta: [
      { id: 'AlsoMissing', order: 'LoadAfterThis' },
      { id: 'Native', order: 'LoadBeforeThis', optional: 'true', version: 'v1.0.0' },
    ],
    subModules: [{ name: 'BrokenDeps', dllName: 'BrokenDeps.dll', classType: 'BrokenDeps.SubModule' }],
  }), ['BrokenDeps.dll'])

  // ── ★ ISSUE: missing_declared_submodule_dll, plus the other SubModule issues in one
  //    module so a single scan reports several severities. ───────────────────
  writeModule(DOCTOR_ROOT, 'MissingDll', subModuleXmlText({
    id: 'MissingDll', name: 'Missing Dll', type: 'Community', category: 'Other',
    deps: ['Native'],
    subModules: [
      // declared but no matching DLL in bin/
      { name: 'GoneDll', dllName: 'Absent.dll', classType: 'MissingDll.Absent' },
      // declares a DLL but no class type
      { name: 'NoClass', dllName: 'NoClass.dll' },
      // declares neither
      { name: 'Neither' },
    ],
  }), ['Present.dll'])

  // ── ★ the LOAD-ORDER CYCLE: CycleA loadAfter CycleB, CycleB loadAfter CycleA ─
  writeModule(DOCTOR_ROOT, 'CycleA', subModuleXmlText({
    id: 'CycleA', name: 'Cycle A', type: 'Community', category: 'Other',
    loadAfter: ['CycleB'],
    subModules: [{ name: 'CycleA', dllName: 'CycleA.dll', classType: 'CycleA.SubModule' }],
  }), ['CycleA.dll'])

  writeModule(DOCTOR_ROOT, 'CycleB', subModuleXmlText({
    id: 'CycleB', name: 'Cycle B', type: 'Community', category: 'Other',
    loadAfter: ['CycleA'],
    subModules: [{ name: 'CycleB', dllName: 'CycleB.dll', classType: 'CycleB.SubModule' }],
  }), ['CycleB.dll'])

  // ── issues that need DLL-level facts: a bundled TaleWorlds assembly, a bundled
  //    shared framework dependency, and the SAME shared DLL in two modules so the
  //    variants rule can compare hashes. The two copies hold DIFFERENT bytes, which is
  //    what conflicting_shared_dependency_variants is looking for. ────────────
  writeModule(DOCTOR_ROOT, 'BundlerOne', subModuleXmlText({
    id: 'BundlerOne', name: 'Bundler One', type: 'Community', category: 'Other',
    subModules: [{ name: 'BundlerOne', dllName: 'BundlerOne.dll', classType: 'BundlerOne.SubModule' }],
  }), ['BundlerOne.dll', 'TaleWorlds.CampaignSystem.dll', '0Harmony.dll', 'Bannerlord.ButterLib.dll'])

  writeModule(DOCTOR_ROOT, 'BundlerTwo', subModuleXmlText({
    id: 'BundlerTwo', name: 'Bundler Two', type: 'Community', category: 'Other',
    subModules: [{ name: 'BundlerTwo', dllName: 'BundlerTwo.dll', classType: 'BundlerTwo.SubModule' }],
  }), ['BundlerTwo.dll', '0Harmony.dll', 'Bannerlord.ButterLib.dll'])

  // ── ISSUE: incompatible_module_present (declares another module incompatible) ─
  writeModule(DOCTOR_ROOT, 'Picky', subModuleXmlText({
    id: 'Picky', name: 'Picky', type: 'Community', category: 'Other',
    incompatible: ['BundlerOne'],
    subModules: [{ name: 'Picky', dllName: 'Picky.dll', classType: 'Picky.SubModule' }],
  }), ['Picky.dll'])

  // ── a module directory with no SubModule.xml at all, which must be SKIPPED ──
  mkdirSync(join(DOCTOR_ROOT, 'Modules', 'NotAModule'), { recursive: true })
  writeFileSync(join(DOCTOR_ROOT, 'Modules', 'NotAModule', 'readme.txt'), 'no SubModule.xml here', 'utf8')

  // ── a plain FILE inside Modules, which must not be treated as a directory ───
  writeFileSync(join(DOCTOR_ROOT, 'Modules', 'stray.txt'), 'stray', 'utf8')

  return DOCTOR_ROOT
}

/** The two copies of a shared DLL must DIFFER in bytes to trip the variants rule. */
export function differentiateSharedDlls() {
  const one = join(DOCTOR_ROOT, 'Modules', 'BundlerOne', 'bin', 'Win64_Shipping_Client', '0Harmony.dll')
  const two = join(DOCTOR_ROOT, 'Modules', 'BundlerTwo', 'bin', 'Win64_Shipping_Client', '0Harmony.dll')
  writeFileSync(one, 'MZ harmony copy ONE — different bytes', 'utf8')
  writeFileSync(two, 'MZ harmony copy TWO — different bytes', 'utf8')
  const butterOne = join(DOCTOR_ROOT, 'Modules', 'BundlerOne', 'bin', 'Win64_Shipping_Client', 'Bannerlord.ButterLib.dll')
  const butterTwo = join(DOCTOR_ROOT, 'Modules', 'BundlerTwo', 'bin', 'Win64_Shipping_Client', 'Bannerlord.ButterLib.dll')
  writeFileSync(butterOne, 'MZ butterlib copy ONE', 'utf8')
  writeFileSync(butterTwo, 'MZ butterlib copy TWO', 'utf8')
}
