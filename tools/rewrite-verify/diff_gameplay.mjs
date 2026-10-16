// Direct baseline-vs-rewrite differential for the ten gameplay getters.
//
// The frozen gameplay fixture covers get_entity for nine kinds but NOT 'troop', so
// trace-troop-tree has no frozen witness. This runner points the real code at the SAME
// fixture database the frozen fixture uses (dist/games/bannerlord-fixture-gameplay) and
// compares the rewrite's rendered text against baseline 8311c9a's, byte for byte.
//
// Usage: bun run tools/rewrite-verify/diff_gameplay.mjs

import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { repoRoot, cleanupShadow, report, loadBoth, diffCases } from './diffharness.mjs'

const FIXTURE_GAME = 'bannerlord-fixture-gameplay'
const fixtureDb = join(repoRoot, 'dist', 'games', FIXTURE_GAME, `${FIXTURE_GAME}.db`)
if (!existsSync(fixtureDb)) {
  console.error(`REFUSING: run gen_gameplay_fixtures.mjs first; ${fixtureDb} is absent`)
  process.exit(3)
}
process.env.BANNERSAGE_GAME = FIXTURE_GAME

cleanupShadow()

// Each file with the export the dispatcher calls and the ids worth exercising. The corpus
// in gen_gameplay_fixtures.mjs supplies rows for every one of these, including the
// empty-string id (a SQL miss, so the not-found branch renders).
const TARGETS = [
  { file: 'src/tools/get-clan-summary.ts', entry: 'getClanSummary',
    ids: ['c_empire', 'c_minor_merc', 'c_minor', 'c_bandit', 'c_plain', 'player_faction', 'nope', ''] },
  { file: 'src/tools/get-culture-summary.ts', entry: 'getCultureSummary',
    ids: ['empire', 'quiet', 'nope', ''] },
  { file: 'src/tools/get-hero-profile.ts', entry: 'getHeroProfile',
    ids: ['h_alive', 'h_dead', 'h_no_troop_row', 'missing_hero', ''] },
  { file: 'src/tools/get-item-stats.ts', entry: 'getItemStats',
    ids: ['sword_a', 'nope', ''] },
  { file: 'src/tools/get-kingdom-summary.ts', entry: 'getKingdomSummary',
    ids: ['k_empire', 'k_empty', 'nope', ''] },
  { file: 'src/tools/get-perk-data.ts', entry: 'getPerkData',
    ids: ['perk_a', 'perk_b', 'perk_c', 'PERK_A', 'nope', ''] },
  { file: 'src/tools/get-policy-summary.ts', entry: 'getPolicySummary',
    ids: ['policy_feudal_inheritance', 'Policy.policy_land_grands_for_veteran',
          'POLICY.FEUDAL_INHERITANCE', 'nope', ''] },
  { file: 'src/tools/get-settlement-summary.ts', entry: 'getSettlementSummary',
    ids: ['town_a', 'village_a', 'castle_a', 'odd_a', 'nope', ''] },
  { file: 'src/tools/get-skill-data.ts', entry: 'getSkillData',
    ids: ['OneHanded', 'Malformed', 'NotArray', 'nope', ''] },
  { file: 'src/tools/trace-troop-tree.ts', entry: 'traceTroopTree',
    ids: ['h_alive', 'h_dead', 'h_template', 'nope', ''] },
]

let allOk = true
let totalCases = 0

for (const target of TARGETS) {
  const { baselineMod, liveMod } = await loadBoth(target.file)
  const baseFn = baselineMod[target.entry]
  const liveFn = liveMod[target.entry]
  if (typeof baseFn !== 'function') throw new Error(`baseline ${target.file} lacks ${target.entry}`)
  if (typeof liveFn !== 'function') throw new Error(`rewrite ${target.file} lacks ${target.entry}`)

  const cases = target.ids.map(id => ({ label: JSON.stringify(id), id }))
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(baseFn, liveFn, cases, async (fn, c) => {
    const res = await fn(c.id)
    return res.content[0].text
  })

  totalCases += cases.length
  allOk = report(target.file, problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

// NOTE: get-entity.ts is the dispatcher and is NOT part of baseline 8311c9a, so there is no
// upstream revision to diff it against. It is covered indirectly: every branch it can take
// is one of the ten getters above, all of which are compared case by case.

cleanupShadow()
console.log(allOk ? `ALL EQUAL — ${totalCases} differential cases` : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
