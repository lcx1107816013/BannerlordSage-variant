// Parity fixture generator for src/utils/bannerlord-module-tooling.ts -> internal/moduletooling.
//
// ★ THE FUNCTION UNDER TEST READS THE FILE SYSTEM, SO THE CORPUS IS REAL DIRECTORIES AND REAL
// SubModule.xml FILES. `loadBannerlordModules` walks `Modules/` under a game dir, so the fixture
// builds one — under tools/parity/fixtures/, never near a real install (ledger F19).
//
// ★ AND THE SHAPE IS EMITTED AS DATA, because a module tree is files and git tracks those happily —
// but one case needs a module directory with NO SubModule.xml, which git represents as an EMPTY
// directory and therefore cannot track. Same lesson as the runtime-check trees, applied before it
// bites: the Go side rebuilds from `shape`.
//
// The corpus separates rules rather than looking realistic:
//   * a module with no SubModule.xml (skipped silently, not reported)
//   * a module whose Id is absent, so the id falls back to the DIRECTORY NAME
//   * a module declaring Official=false while its id is in the official SET (the set wins)
//   * a module with officialFlag absent but ModuleType=Official (the type wins)
//   * duplicate module ids (the doctor reports one issue PER duplicate, not one per id)
//   * a dependency on a module that is NOT installed, and one on a module that is
//   * metadata that is optional and missing (no issue) versus required and missing (warning)
//   * an incompatible module that IS installed, and one that is not
//   * a SubModule with no DLLName, one with no class type, one whose DLL is absent
//   * a non-official module shipping a TaleWorlds.* DLL
//   * two modules bundling DIFFERENT variants of 0Harmony.dll (md5 differs) — a conflict
//   * the canonical owner bundling its own 0Harmony.dll (no bundled_shared_dependency for it)
//   * LoadBeforeThis / LoadAfterThis metadata ordering versus LoadAfter / DependedModules
//   * a THREE-MODULE CYCLE, so the topological sort reports unresolved ids
//
// Usage: bun run server-go/tools/parity/gen_moduletooling_fixtures.mjs

import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)
const u = p => pathToFileURL(p).href

const fixturesDir = join(here, 'fixtures')
mkdirSync(fixturesDir, { recursive: true })

const gameDir = join(fixturesDir, 'moduletooling-game')
if (existsSync(gameDir)) rmSync(gameDir, { recursive: true, force: true })

// ── the corpus: modules, their SubModule.xml bodies, and their bin DLLs ──────
// `bin` entries are DLL file names; a nested subdirectory is expressed with a slash.
const MODULES = {
  // ★ THE OTHER SPELLING OF THE OFFICIAL SET'S SANDBOX ENTRY. The set contains BOTH `Sandbox` and
  // `SandBox`, and this module's id is the second one — so removing that entry from the set changes
  // this module's isOfficial. Added because a mutant that dropped it survived: the corpus had only
  // the first spelling.
  SandBoxOpt: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="SandBoxOpt" />
  <Id value="SandBox" />
  <SubModules>
    <SubModule>
      <Name value="SandBoxOpt" />
      <DLLName value="SandBoxOpt.dll" />
      <SubModuleClassType value="SandBoxOpt.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['SandBoxOpt.dll'],
  },
  // An official module by ID, with no Official flag at all.
  Native: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Native" />
  <Id value="Native" />
  <Version value="v1.2.9" />
  <SubModules>
    <SubModule>
      <Name value="Native" />
      <DLLName value="TaleWorlds.Native.dll" />
      <SubModuleClassType value="TaleWorlds.Native.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['TaleWorlds.Native.dll'],
  },
  // Official by TYPE (lowercase 'official'), with a DIFFERENT case in the id set spelling.
  SandBox: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="SandBox" />
  <Id value="Sandbox" />
  <ModuleType value="official" />
  <SubModules>
    <SubModule>
      <Name value="SandBox" />
      <DLLName value="SandBox.dll" />
      <SubModuleClassType value="SandBox.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['SandBox.dll'],
  },
  // Official by FLAG, with a FALSE value that the set then overrides.
  CustomBattle: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="CustomBattle" />
  <Id value="CustomBattle" />
  <Official value="false" />
  <SubModules>
    <SubModule>
      <Name value="CustomBattle" />
      <DLLName value="CustomBattle.dll" />
      <SubModuleClassType value="CustomBattle.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['CustomBattle.dll'],
  },
  // A BROKEN community module: no DLLName, a second SubModule with no class type and a missing DLL,
  // a missing dependency, required metadata that is missing, an optional one that is missing, an
  // installed incompatible module and an uninstalled one, plus a shipped TaleWorlds DLL.
  BrokenMod: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Broken Mod" />
  <Id value="BrokenMod" />
  <Version value="1.0.0" />
  <DependedModules>
    <DependedModule Id="Native" />
    <DependedModule Id="NotInstalledDep" />
  </DependedModules>
  <DependedModuleMetadatas>
    <DependedModuleMetadata id="Native" order="LoadBeforeThis" optional="false" version="v1.2.9" />
    <DependedModuleMetadata id="AlsoMissing" order="LoadAfterThis" optional="false" />
    <DependedModuleMetadata id="OptionalMissing" optional="true" />
    <DependedModuleMetadata id="Sandbox" order="LoadAfterThis" />
  </DependedModuleMetadatas>
  <IncompatibleModules>
    <IncompatibleModule Id="Native" />
    <IncompatibleModule Id="AlsoNotInstalled" />
  </IncompatibleModules>
  <SubModules>
    <SubModule>
      <Name value="NoDllName" />
      <SubModuleClassType value="X.Y" />
    </SubModule>
    <SubModule>
      <Name value="NoClassType" />
      <DLLName value="Missing.dll" />
    </SubModule>
    <SubModule>
      <Name value="WithAssembliesAndTags" />
      <DLLName value="Broken.dll" />
      <SubModuleClassType value="Broken.SubModule" />
      <Assemblies>
        <Assembly value="Assembly.One" />
        <Assembly value="Assembly.Two" />
      </Assemblies>
      <Tags>
        <Tag key="k1" value="v1" />
        <Tag key="k2" />
        <Tag value="v3" />
      </Tags>
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['Broken.dll', 'TaleWorlds.Library.dll', 'bin/Win64_Shipping_Client/nested.dll'],
  },
  // A second module with the SAME id, to exercise duplicate_module_id (one issue per duplicate).
  BrokenModTwin: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Broken Mod Twin" />
  <Id value="BrokenMod" />
  <SubModules>
    <SubModule>
      <Name value="Twin" />
      <DLLName value="Twin.dll" />
      <SubModuleClassType value="Twin.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['Twin.dll'],
  },
  // No <Id> at all, so the id falls back to the DIRECTORY name (this one is directory `NoIdMod`).
  NoIdMod: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="No Id Module" />
  <SubModules>
    <SubModule>
      <Name value="NoId" />
      <DLLName value="NoId.dll" />
      <SubModuleClassType value="NoId.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['NoId.dll'],
  },
  // Bundles the CANONICAL 0Harmony.dll under the canonical module id: no bundled issue, but it joins
  // the shared group so the variant check sees it.
  'Bannerlord.Harmony': {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Harmony" />
  <Id value="Bannerlord.Harmony" />
  <SubModules>
    <SubModule>
      <Name value="Harmony" />
      <DLLName value="0Harmony.dll" />
      <SubModuleClassType value="Harmony.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['0Harmony.dll'],
  },
  // A community module bundling ANOTHER copy of 0Harmony.dll — a bundled_shared_dependency warning,
  // and (with a different md5) part of the conflicting-variants error.
  HarmonyBundler: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Harmony Bundler" />
  <Id value="HarmonyBundler" />
  <SubModules>
    <SubModule>
      <Name value="Bundler" />
      <DLLName value="Bundler.dll" />
      <SubModuleClassType value="Bundler.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['Bundler.dll', '0harmony.dll'],
  },
  // An OFFICIAL module also shipping 0Harmony.dll: it must NOT join the shared groups at all.
  OfficialHarmony: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Official Harmony Carrier" />
  <Id value="OfficialHarmony" />
  <ModuleType value="Official" />
  <SubModules>
    <SubModule>
      <Name value="Carrier" />
      <DLLName value="Carrier.dll" />
      <SubModuleClassType value="Carrier.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['Carrier.dll', '0Harmony.dll'],
  },
  // The three modules of a CYCLE.
  CycleA: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Cycle A" />
  <Id value="CycleA" />
  <DependedModules>
    <DependedModule Id="CycleC" />
  </DependedModules>
  <SubModules>
    <SubModule>
      <Name value="A" />
      <DLLName value="CycleA.dll" />
      <SubModuleClassType value="CycleA.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['CycleA.dll'],
  },
  CycleB: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Cycle B" />
  <Id value="CycleB" />
  <DependedModules>
    <DependedModule Id="CycleA" />
  </DependedModules>
  <SubModules>
    <SubModule>
      <Name value="B" />
      <DLLName value="CycleB.dll" />
      <SubModuleClassType value="CycleB.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['CycleB.dll'],
  },
  CycleC: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Cycle C" />
  <Id value="CycleC" />
  <DependedModules>
    <DependedModule Id="CycleB" />
  </DependedModules>
  <SubModules>
    <SubModule>
      <Name value="C" />
      <DLLName value="CycleC.dll" />
      <SubModuleClassType value="CycleC.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['CycleC.dll'],
  },
  // A module that must load AFTER another by three different declarations, all pointing the same way.
  Ordering: {
    xml: `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="Ordering" />
  <Id value="Ordering" />
  <ModulesToLoadAfterThis>
    <Module Id="Native" />
  </ModulesToLoadAfterThis>
  <DependedModuleMetadatas>
    <DependedModuleMetadata id="Sandbox" order="LoadAfterThis" />
    <DependedModuleMetadata id="CycleA" order="LoadBeforeThis" />
  </DependedModuleMetadatas>
  <SubModules>
    <SubModule>
      <Name value="Ordering" />
      <DLLName value="Ordering.dll" />
      <SubModuleClassType value="Ordering.SubModule" />
    </SubModule>
  </SubModules>
</Module>`,
    bin: ['Ordering.dll'],
  },
  // ★ NO SubModule.xml AT ALL: the directory exists and must be SKIPPED SILENTLY.
  EmptyDir: { xml: null, bin: [] },
}

const SHAPE = { modules: {} }
for (const [dirName, spec] of Object.entries(MODULES)) {
  SHAPE.modules[dirName] = { xml: spec.xml, bin: spec.bin }
}

// ── build it ────────────────────────────────────────────────────────────────
const modulesDir = join(gameDir, 'Modules')
mkdirSync(modulesDir, { recursive: true })
for (const [dirName, spec] of Object.entries(MODULES)) {
  const moduleDir = join(modulesDir, dirName)
  mkdirSync(moduleDir, { recursive: true })
  if (spec.xml !== null) writeFileSync(join(moduleDir, 'SubModule.xml'), spec.xml)
  for (const dll of spec.bin) {
    const full = join(moduleDir, 'bin', ...dll.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    // The CONTENT differs per module for 0Harmony.dll, so the md5-based variant check has something
    // to detect; every other DLL gets its own name as content, which is enough to be distinct.
    writeFileSync(full, `content of ${dll} in ${dirName}`)
  }
}

// ── run the real TypeScript ─────────────────────────────────────────────────
const mod = await import(u(join(repoRoot, 'src', 'utils', 'bannerlord-module-tooling.ts')))

const modules = await mod.loadBannerlordModules(gameDir)

// The module objects carry the paths they were found at; strip the fixture root so the Go side can
// rebuild the same tree elsewhere and still compare.
const stripRoot = value => (typeof value === 'string' ? value.slice(gameDir.length + 1).split('\\').join('/') : value)

const loadedCases = modules.map(m => ({
  ...m,
  moduleDir: stripRoot(m.moduleDir),
  subModulePath: stripRoot(m.subModulePath),
  dllFiles: m.dllFiles.map(d => ({ ...d, relativePath: d.relativePath })),
}))

// ── the analysis functions, over hand-built module lists ────────────────────
// These take plain objects, so they are driven with SMALL, deliberately-shaped inputs rather than
// with the loaded corpus: the load-order and issue logic is what is being separated here.
const mkModule = (over = {}) => ({
  moduleId: 'M', moduleName: 'M', version: null, moduleType: null, moduleCategory: null,
  officialFlag: null, defaultModule: null, isOfficial: false,
  moduleDir: 'D:/x/Modules/M', subModulePath: 'D:/x/Modules/M/SubModule.xml',
  dependencies: [], loadAfter: [], incompatible: [], dependencyMetadata: [],
  subModules: [], dllFiles: [], ...over,
})

const ORDER_CASES = {
  'empty list': [],
  'a single module': [mkModule({ moduleId: 'A' })],
  'official first': [
    mkModule({ moduleId: 'Community', isOfficial: false }),
    mkModule({ moduleId: 'Official', isOfficial: true }),
  ],
  'a dependency edge': [
    mkModule({ moduleId: 'Dep' }),
    mkModule({ moduleId: 'User', dependencies: ['Dep'] }),
  ],
  'an edge to a module that is absent': [
    mkModule({ moduleId: 'User', dependencies: ['Ghost'] }),
  ],
  'LoadAfter': [
    mkModule({ moduleId: 'A', loadAfter: ['B'] }),
    mkModule({ moduleId: 'B' }),
  ],
  'LoadBeforeThis metadata': [
    mkModule({ moduleId: 'A', dependencyMetadata: [{ moduleId: 'B', order: 'LoadBeforeThis', optional: false, version: null }] }),
    mkModule({ moduleId: 'B' }),
  ],
  'LoadAfterThis metadata': [
    mkModule({ moduleId: 'A', dependencyMetadata: [{ moduleId: 'B', order: 'LoadAfterThis', optional: false, version: null }] }),
    mkModule({ moduleId: 'B' }),
  ],
  // ★ THE DEDUPE GUARD NEEDS AN EDGE ADDED TWICE BY THE SAME SOURCE. A dependency + loadAfter pair
  // does NOT reach it: the guard is per-source (`fromSet`), and those two edges have DIFFERENT
  // sources. The shape that reaches it is one module declaring the same dependency twice through two
  // containers — DependedModules AND a LoadBeforeThis metadata entry.
  'the same edge from one source, twice (dedupe guard)': [
    mkModule({ moduleId: 'A', dependencies: ['B'], dependencyMetadata: [{ moduleId: 'B', order: 'LoadBeforeThis', optional: false, version: null }] }),
    mkModule({ moduleId: 'B' }),
  ],
  // ★ THE READY-SET SORT NEEDS TWO MODULES READY AT ONCE with no edge between them, one official and
  // one not — otherwise the sort has nothing to reorder and removing it changes nothing.
  'two ready modules of different kinds (the sort decides)': [
    mkModule({ moduleId: 'Zed', isOfficial: false }),
    mkModule({ moduleId: 'Alpha', isOfficial: true }),
    mkModule({ moduleId: 'Mid', isOfficial: false }),
  ],
  // ★ AND IT NEEDS A CASE WHERE THE SECOND ROUND IS WHAT MATTERS, because the sort runs BOTH before
  // the loop and after every pop. Here an OFFICIAL module becomes ready only in a later round, while
  // a COMMUNITY module is already queued: the in-loop sort is what puts the official one first.
  // Removing that sort leaves the community module ahead of it in the output.
  'an official module that becomes ready later (the in-loop sort)': [
    mkModule({ moduleId: 'Gate', isOfficial: false }),
    mkModule({ moduleId: 'LateOfficial', isOfficial: true, dependencies: ['Gate'] }),
    mkModule({ moduleId: 'EarlyCommunity', isOfficial: false }),
  ],
  'a dependency and a loadAfter (two different sources)': [
    mkModule({ moduleId: 'A', dependencies: ['B'], loadAfter: ['B'] }),
    mkModule({ moduleId: 'B' }),
  ],
  'a two-module cycle': [
    mkModule({ moduleId: 'A', dependencies: ['B'] }),
    mkModule({ moduleId: 'B', dependencies: ['A'] }),
  ],
  'a cycle plus a module that can load': [
    mkModule({ moduleId: 'A', dependencies: ['B'] }),
    mkModule({ moduleId: 'B', dependencies: ['A'] }),
    mkModule({ moduleId: 'Free' }),
  ],
}

const orderCases = []
for (const [label, list] of Object.entries(ORDER_CASES)) {
  orderCases.push({ label, modules: list, result: mod.buildRecommendedLoadOrder(list) })
}

const ISSUE_CASES = {
  'no modules': [],
  'one clean module': [mkModule({ moduleId: 'Clean', subModules: [{ name: 'S', dllName: 'S.dll', classType: 'S.T', assemblies: [], tags: [] }], dllFiles: [{ fileName: 'S.dll', relativePath: 'bin/S.dll', md5: null }] })],
  'a duplicate id': [
    mkModule({ moduleId: 'Dup' }),
    mkModule({ moduleId: 'Dup', moduleDir: 'D:/x/Modules/Dup2', subModulePath: 'D:/x/Modules/Dup2/SubModule.xml' }),
  ],
  'a missing dependency': [mkModule({ moduleId: 'A', dependencies: ['Ghost'] })],
  'a missing required metadata target': [mkModule({ moduleId: 'A', dependencyMetadata: [{ moduleId: 'Ghost', order: null, optional: false, version: null }] })],
  'a missing OPTIONAL metadata target': [mkModule({ moduleId: 'A', dependencyMetadata: [{ moduleId: 'Ghost', order: null, optional: true, version: null }] })],
  'an installed incompatible module': [
    mkModule({ moduleId: 'A', incompatible: ['B'] }),
    mkModule({ moduleId: 'B' }),
  ],
  'a submodule with no dll name': [mkModule({ moduleId: 'A', subModules: [{ name: 'S', dllName: null, classType: 'S.T', assemblies: [], tags: [] }] })],
  'a submodule with no class type': [mkModule({ moduleId: 'A', subModules: [{ name: 'S', dllName: 'S.dll', classType: null, assemblies: [], tags: [] }] })],
  // ★ THE CASE-SENSITIVITY OF THE DLL LOOKUP. The declared name differs from the file name ONLY in
  // case, so a case-sensitive comparison reports a missing DLL that IS present.
  'a declared dll differing only in CASE (present, so no issue)': [
    mkModule({ moduleId: 'A', subModules: [{ name: 'S', dllName: 's.dll', classType: 'S.T', assemblies: [], tags: [] }], dllFiles: [{ fileName: 'S.dll', relativePath: 'bin/S.dll', md5: null }] }),
  ],
  'a declared dll absent in any case (an issue)': [
    mkModule({ moduleId: 'A', subModules: [{ name: 'S', dllName: 'S.DLL', classType: 'S.T', assemblies: [], tags: [] }], dllFiles: [{ fileName: 'Other.dll', relativePath: 'bin/Other.dll', md5: null }] }),
  ],
  // ★ AN OFFICIAL MODULE BUNDLING A SHARED DLL BESIDE CONFLICTING COMMUNITY ONES. Officials are
  // excluded from the shared groups, so the group holds only the two community copies; including
  // officials adds a third membership and changes both the variants and the conflicts.
  'an official module bundling a shared dll beside conflicting community ones': [
    mkModule({ moduleId: 'Official', isOfficial: true, dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'officialVariant' }] }),
    mkModule({ moduleId: 'CommunityA', moduleDir: 'D:/x/Modules/CommunityA', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'communityA' }] }),
    mkModule({ moduleId: 'CommunityB', moduleDir: 'D:/x/Modules/CommunityB', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'communityB' }] }),
  ],
  'a declared dll that is absent': [mkModule({ moduleId: 'A', subModules: [{ name: 'S', dllName: 'S.dll', classType: 'S.T', assemblies: [], tags: [] }], dllFiles: [] })],
  'a community module shipping TaleWorlds': [mkModule({ moduleId: 'A', dllFiles: [{ fileName: 'TaleWorlds.Library.dll', relativePath: 'bin/TaleWorlds.Library.dll', md5: null }] })],
  'an OFFICIAL module shipping TaleWorlds (no issue)': [mkModule({ moduleId: 'A', isOfficial: true, dllFiles: [{ fileName: 'TaleWorlds.Library.dll', relativePath: 'bin/TaleWorlds.Library.dll', md5: null }] })],
  'a bundled shared dependency': [mkModule({ moduleId: 'A', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'aaa' }] })],
  'the canonical owner bundling it (no bundled issue)': [mkModule({ moduleId: 'Bannerlord.Harmony', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'aaa' }] })],
  'two DIFFERENT variants of one shared dll': [
    mkModule({ moduleId: 'X', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'aaa' }] }),
    mkModule({ moduleId: 'Y', moduleDir: 'D:/x/Modules/Y', dllFiles: [{ fileName: '0harmony.dll', relativePath: 'bin/0harmony.dll', md5: 'bbb' }] }),
  ],
  'two IDENTICAL variants (no conflict)': [
    mkModule({ moduleId: 'X', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'same' }] }),
    mkModule({ moduleId: 'Y', moduleDir: 'D:/x/Modules/Y', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: 'same' }] }),
  ],
  'two unhashed copies (the fallback key)': [
    mkModule({ moduleId: 'X', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: null }] }),
    mkModule({ moduleId: 'Y', moduleDir: 'D:/x/Modules/Y', dllFiles: [{ fileName: '0Harmony.dll', relativePath: 'bin/0Harmony.dll', md5: null }] }),
  ],
}

const issueCases = []
for (const [label, list] of Object.entries(ISSUE_CASES)) {
  issueCases.push({ label, modules: list, result: await mod.collectDoctorIssues(list) })
}

// ── focus selection ─────────────────────────────────────────────────────────
const FOCUS_MODULES = [
  mkModule({ moduleId: 'Official', isOfficial: true, moduleDir: 'D:/x/Modules/Official' }),
  mkModule({ moduleId: 'Community', isOfficial: false, moduleDir: 'D:/x/Modules/Community' }),
  mkModule({ moduleId: 'Community', isOfficial: false, moduleDir: 'D:/x/Modules/CommunityTwo' }),
  // ★ A PAIR WHERE ONE ID IS A PROPER SUBSTRING OF THE OTHER, so a substring comparison selects BOTH
  // where the exact comparison selects one. The id below is a prefix-SUBSTRING pair with `PrefixMod`.
  mkModule({ moduleId: 'PrefixMod', isOfficial: false, moduleDir: 'D:/x/Modules/PrefixMod' }),
  mkModule({ moduleId: 'Mod', isOfficial: false, moduleDir: 'D:/x/Modules/Mod' }),
]
const focusCases = [
  { label: 'neither argument', args: [undefined, undefined] },
  { label: 'an empty id', args: ['', undefined] },
  { label: 'a whitespace id', args: ['   ', undefined] },
  { label: 'a matching id', args: ['Community', undefined] },
  { label: 'a non-matching id', args: ['Nope', undefined] },
  { label: 'an id with surrounding spaces', args: ['  Community  ', undefined] },
  // ★ THE SUBSTRING DISCRIMINATOR: `Mod` is a substring of `PrefixMod`, so a substring comparison
  // would select TWO modules here where the exact comparison selects one.
  { label: 'an id that is a substring of another (exact only)', args: ['Mod', undefined] },
  // ★ AND THE REVERSE DIRECTION: a filter that is CONTAINED IN an id selects NOTHING exactly, while a
  // substring comparison would select it.
  { label: 'a filter contained in an id (exact only)', args: ['Prefi', undefined] },
  { label: 'a matching path', args: [undefined, 'D:/x/Modules/Community'] },
  { label: 'a path that matches nothing', args: [undefined, 'D:/x/Modules/Nope'] },
]
const focusResults = focusCases.map(c => ({
  ...c,
  result: mod.computeDoctorFocusModules(FOCUS_MODULES, c.args[0], c.args[1]).map(m => m.moduleId + '|' + m.moduleDir),
}))

// All-official list, to pin the fallback that returns EVERYTHING.
const allOfficial = [mkModule({ moduleId: 'O1', isOfficial: true }), mkModule({ moduleId: 'O2', isOfficial: true })]

// ── the officialness matrix ─────────────────────────────────────────────────
//
// ★ THIS IS THE ONE PLACE THE PORT *IS* THE DECISION, because the loader is not ported: a caller
// supplies parsed modules, and ModuleInfo.IsOfficial has to be computed by the Go side. So the rule
// is exercised by the REAL loader here — one module per case, built into a throwaway tree — and the
// Go predicate is compared against it.
const OFFICIAL_MATRIX = [
  { id: 'Native', type: null, official: null },
  { id: 'SandBox', type: null, official: null },
  { id: 'Sandbox', type: null, official: null },
  { id: 'SANDBOX', type: null, official: null },
  { id: 'sandbox', type: null, official: null },
  { id: 'Community', type: 'official', official: null },
  { id: 'Community', type: 'Official', official: null },
  { id: 'Community', type: 'OFFICIAL', official: null },
  { id: 'Community', type: '  official  ', official: null },
  { id: 'Community', type: 'notofficial', official: null },
  { id: 'Community', type: null, official: 'true' },
  { id: 'Community', type: null, official: 'TRUE' },
  { id: 'Community', type: null, official: 'false' },
  { id: 'CustomBattle', type: null, official: 'false' },
  { id: 'Community', type: null, official: null },
  { id: '', type: null, official: null },
]

const matrixRoot = join(fixturesDir, 'moduletooling-official-matrix')
if (existsSync(matrixRoot)) rmSync(matrixRoot, { recursive: true, force: true })
const matrixModules = join(matrixRoot, 'Modules')
mkdirSync(matrixModules, { recursive: true })

const officialMatrix = []
for (const [index, c] of OFFICIAL_MATRIX.entries()) {
  const dirName = `M${String(index).padStart(2, '0')}`
  const moduleDir = join(matrixModules, dirName)
  mkdirSync(moduleDir, { recursive: true })
  // The id is written only when the case HAS one; an absent <Id> exercises the directory-name
  // fallback, which is why the empty-string case is written as absent and the label says so.
  const idLine = c.id === '' ? '' : `  <Id value="${c.id}" />`
  const typeLine = c.type === null ? '' : `  <ModuleType value="${c.type}" />`
  const officialLine = c.official === null ? '' : `  <Official value="${c.official}" />`
  writeFileSync(join(moduleDir, 'SubModule.xml'), `<?xml version="1.0" encoding="utf-8"?>
<Module>
  <Name value="${dirName}" />
${idLine}
${typeLine}
${officialLine}
</Module>`)
  officialMatrix.push({ index, dirName, ...c })
}

const matrixLoaded = await mod.loadBannerlordModules(matrixRoot)
for (const row of officialMatrix) {
  const found = matrixLoaded.find(m => m.moduleDir.endsWith(row.dirName))
  row.loadedModuleId = found ? found.moduleId : null
  row.isOfficial = found ? found.isOfficial : null
}
rmSync(matrixRoot, { recursive: true, force: true })

const fixtures = {
  officialMatrix,
  _comment:
    'GENERATED by gen_moduletooling_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/bannerlord-module-tooling.ts: loadBannerlordModules against the tree described by ' +
    '`shape`, and the analysis functions against deliberately-shaped module lists. The Go test ' +
    'rebuilds the tree from `shape`, which contains a module directory with NO SubModule.xml — an ' +
    'EMPTY directory git cannot track. Do not edit by hand.',
  shape: SHAPE,
  gameDirRel: 'tools/parity/fixtures/moduletooling-game',
  loadedCases,
  orderCases,
  issueCases,
  focusCases: focusResults,
  allOfficialFocus: mod.computeDoctorFocusModules(allOfficial, undefined, undefined).map(m => m.moduleId),
}
writeFileSync(join(here, 'moduletooling_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote moduletooling_fixtures.json + fixtures/moduletooling-game/')
console.log('  loaded modules : ' + loadedCases.length + ' (of ' + Object.keys(MODULES).length + ' directories)')
console.log('  order cases    : ' + orderCases.length)
console.log('  issue cases    : ' + issueCases.length + ' (' + issueCases.reduce((n, c) => n + c.result.length, 0) + ' issues)')
console.log('  focus cases    : ' + focusResults.length)
console.log('')
const dupCase = issueCases.find(c => c.label === 'a duplicate id')
console.log('  ★ the uncounted directory: `EmptyDir` has no SubModule.xml, so ' +
  Object.keys(MODULES).length + ' dirs produced ' + loadedCases.length + ' modules')
console.log('  ★ duplicate id issues (both copies reported, so issues = modules, not ids): ' + dupCase.result.length)
const cycle = orderCases.find(c => c.label === 'a two-module cycle')
console.log('  ★ the cycle: ordered=' + JSON.stringify(cycle.result.orderedModuleIds) +
  ' unresolved=' + JSON.stringify(cycle.result.unresolvedModuleIds))
