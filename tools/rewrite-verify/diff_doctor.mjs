// Direct baseline-vs-rewrite differential for bannerlord-doctor.ts — its ONLY witness.
//
// No frozen fixture touches this file: gen_moduletooling_fixtures.mjs exercises
// src/utils/bannerlord-module-tooling.ts (the issue collectors and the load-order sort), never
// the tool that composes them into a report. So the report's own decisions — which issues get
// filtered to the focused set, which official modules get skipped, the block order, the
// `doctor_target` label — are unpinned without this runner.
//
// The corpus is built by doctor-game.mjs and trips TEN of the tool's eleven issue types,
// including the three the Lead named as required: duplicate_module_id, missing_dependency and
// missing_declared_submodule_dll. It also contains a real load-order cycle, two byte-different
// copies of the same shared DLL, a bundled TaleWorlds assembly, a module directory with no
// SubModule.xml, and a stray file inside Modules/.
//
// The case list sweeps the call shapes that change the report's structure:
//   * no arguments            -> focus = all non-official modules, official module blocks skipped
//   * a single moduleId       -> focus = that module, so the official-skip rule is bypassed
//   * includeOfficialDetails  -> official module blocks appear even with several focused
//   * a modulePath            -> the path-based focus branch
//   * an absent moduleId/path -> the "no module matched" early return, which interpolates BOTH raw args
//
// Usage: bun run tools/rewrite-verify/diff_doctor.mjs

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { repoRoot, cleanupShadow, report, loadBoth, diffCases } from './diffharness.mjs'
import { buildDoctorGame, differentiateSharedDlls, DOCTOR_ROOT } from './doctor-game.mjs'

const root = buildDoctorGame()
differentiateSharedDlls()
if (!existsSync(join(root, 'Modules'))) {
  console.error('REFUSING: the synthetic module tree was not created')
  process.exit(3)
}

cleanupShadow()
let allOk = true

const CASES = [
  { label: 'no args -> non-official focus', gameDir: root, moduleId: undefined, modulePath: undefined, includeOfficialDetails: false },
  { label: 'native module only (official)', gameDir: root, moduleId: 'Native', modulePath: undefined, includeOfficialDetails: false },
  { label: 'SandBox module (official)', gameDir: root, moduleId: 'SandBox', modulePath: undefined, includeOfficialDetails: false },
  { label: 'HealthyMod (duplicate id pair)', gameDir: root, moduleId: 'HealthyMod', modulePath: undefined, includeOfficialDetails: false },
  { label: 'BrokenDeps (missing dep)', gameDir: root, moduleId: 'BrokenDeps', modulePath: undefined, includeOfficialDetails: false },
  { label: 'MissingDll (three submodule issues)', gameDir: root, moduleId: 'MissingDll', modulePath: undefined, includeOfficialDetails: false },
  { label: 'CycleA (cycle member)', gameDir: root, moduleId: 'CycleA', modulePath: undefined, includeOfficialDetails: false },
  { label: 'BundlerOne (shared + taleworlds dlls)', gameDir: root, moduleId: 'BundlerOne', modulePath: undefined, includeOfficialDetails: false },
  { label: 'Picky (incompatible target)', gameDir: root, moduleId: 'Picky', modulePath: undefined, includeOfficialDetails: false },
  { label: 'includeOfficialDetails with no moduleId', gameDir: root, moduleId: undefined, modulePath: undefined, includeOfficialDetails: true },
  { label: 'includeOfficialDetails + official module', gameDir: root, moduleId: 'Native', modulePath: undefined, includeOfficialDetails: true },
  { label: 'modulePath focus', gameDir: root, moduleId: undefined, modulePath: join(root, 'Modules', 'MissingDll'), includeOfficialDetails: false },
  { label: 'modulePath focus on official', gameDir: root, moduleId: undefined, modulePath: join(root, 'Modules', 'Native'), includeOfficialDetails: false },
  { label: 'absent moduleId -> early return', gameDir: root, moduleId: 'NoSuchModule', modulePath: undefined, includeOfficialDetails: false },
  { label: 'absent modulePath -> early return', gameDir: root, moduleId: undefined, modulePath: join(root, 'Modules', 'NoSuchDir'), includeOfficialDetails: false },
  { label: 'absent moduleId AND modulePath (both interpolate)', gameDir: root, moduleId: 'Ghost', modulePath: '/nope/ghost', includeOfficialDetails: false },
  { label: 'empty-string moduleId is falsy -> normal focus', gameDir: root, moduleId: '', modulePath: undefined, includeOfficialDetails: false },
  { label: 'whitespace moduleId -> trimmed to empty -> normal focus', gameDir: root, moduleId: '   ', modulePath: undefined, includeOfficialDetails: false },
  { label: 'moduleId with surrounding spaces', gameDir: root, moduleId: '  MissingDll  ', modulePath: undefined, includeOfficialDetails: false },
  {
    label: 'empty modules tree -> the no-modules sentence',
    gameDir: join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'doctor-empty'),
    moduleId: undefined,
    modulePath: undefined,
    includeOfficialDetails: false,
    prepare: async () => {
      const { mkdirSync, rmSync } = await import('node:fs')
      const empty = join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'doctor-empty')
      rmSync(empty, { recursive: true, force: true })
      // Modules/ AND bin/ are both required for the directory to pass as a game dir, even
      // when Modules/ is empty — that is the branch this case exists to reach.
      mkdirSync(join(empty, 'Modules'), { recursive: true })
      mkdirSync(join(empty, 'bin', 'Win64_Shipping_Client'), { recursive: true })
    },
  },
  {
    label: 'PATH points at a file -> modules tree unreadable',
    gameDir: join(root, 'Modules', 'stray.txt'),
    moduleId: undefined,
    modulePath: undefined,
    includeOfficialDetails: false,
    expectThrow: true,
  },
]

const { baselineMod, liveMod } = await loadBoth('src/tools/bannerlord-doctor.ts')
if (typeof baselineMod.bannerlordDoctor !== 'function') {
  throw new Error('baseline bannerlord-doctor.ts has no bannerlordDoctor export')
}
if (typeof liveMod.bannerlordDoctor !== 'function') {
  throw new Error('rewrite bannerlord-doctor.ts has no bannerlordDoctor export')
}

// Cases that must build their own precondition first.
for (const c of CASES) {
  if (c.prepare) await c.prepare()
}

const { problems, expectedThrows, unexpectedThrows } = await diffCases(
  baselineMod.bannerlordDoctor,
  liveMod.bannerlordDoctor,
  CASES,
  (fn, c) => fn(c.gameDir, c.moduleId, c.modulePath, c.includeOfficialDetails)
)

allOk = report('src/tools/bannerlord-doctor.ts', problems, CASES.length, unexpectedThrows, expectedThrows) && allOk

// Sanity: the report must actually carry the three required issue types on the
// no-arguments run, otherwise the corpus proves much less than it claims.
{
  const noArgs = await liveMod.bannerlordDoctor(root)
  const text = noArgs.content[0].text
  const required = ['duplicate_module_id', 'missing_dependency', 'missing_declared_submodule_dll']
  const absent = required.filter(t => !text.includes(t))
  if (absent.length > 0) {
    console.log(`WEAK CORPUS: the no-argument report does not mention ${absent.join(', ')}`)
    allOk = false
  } else {
    console.log('CORPUS OK: the no-argument report carries duplicate_module_id, missing_dependency and missing_declared_submodule_dll')
  }
}

void DOCTOR_ROOT
cleanupShadow()
console.log(allOk ? 'ALL EQUAL' : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
