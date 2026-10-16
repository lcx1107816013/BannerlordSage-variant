// Builds a synthetic XML tree for the read-gauntlet-ui differential.
//
// WHY SYNTHETIC: the tool walks a sandbox for `**/*.xml` and picks by file stem, so the corpus
// exists to pin the SELECTION rules, which are the part a re-implementation can silently break:
//
//   * exact stem beats prefix                      -> 'Widget' resolves to Widget.xml
//   * prefix match when nothing is exact           -> 'Wid' resolves by prefix
//   * ranking inside the prefix set                -> the three scored markers, plus unscored
//   * ties fall back to localeCompare on the path  -> two files scoring alike, same stem
//   * the stem is case-folded                      -> query 'WIDGET' finds widget.xml
//   * nested subtrees are scanned recursively      -> a deep file is still a candidate
//
// ★★ THE SCORE MARKERS NEED A LEADING PATH SEGMENT, AND THIS IS A MEASURED TRAP.
//    getUiMatchScore tests for '/gui/prefabs/', '/gui/' and '/prefabs/' — each WITH a leading
//    slash. buildUiIndex globs with cwd = the sandbox root, so it yields paths RELATIVE to that
//    root, with no leading separator:
//
//        'gui/prefabs/PanelPrefab.xml'   -> contains '/prefabs/'   (10)   NOT '/gui/prefabs/' (30)
//        'gui/PanelGui.xml'              -> contains NEITHER marker (0)
//        'prefabs/PanelBare.xml'         -> contains NEITHER marker (0)
//
//    Measured, not reasoned: a probe over the real Glob output shows
//        "gui/prefabs/PanelPrefab.xml"  /gui/prefabs/ = false  /gui/ = false  /prefabs/ = true
//        "gui/PanelGui.xml"             /gui/prefabs/ = false  /gui/ = false  /prefabs/ = false
//    So with a RELATIVE scan root only the 10-point marker is reachable at all, and a corpus
//    built that way cannot observe the 30- or 20-point branches. The tree below therefore puts
//    each scored shape behind an extra leading segment ('assets/gui/...'), which is what makes
//    '/gui/prefabs/' and '/gui/' appear in the path and the top two ranks observable.
//    The relative forms are kept TOO, because "no marker matches" is itself behaviour worth
//    pinning — it is the branch every real relative scan falls into.
//
// NOTE ON THE REVISION CHECK: readGauntletUi calls ensureRuntimeRevisionFresh() with NO game
// id, and that defaults to 'bannerlord' (NOT the active game), so it reads
// dist/games/bannerlord/Version.txt. The runner points BANNERSAGE_GAME at a synthetic id for
// path resolution but leaves that bannerlord revision file alone — the check only fires an
// invalidator when the value CHANGES, so a stable file means the caches behave deterministically.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './diffharness.mjs'

export const GAUNTLET_ROOT = join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'gauntlet-ui')

/** A UI file with the two attribute shapes the extractor reads. */
function uiXml(dataSources, clickCommands) {
  const sources = dataSources.map(ds => `  <Widget DataSource="{${ds}}" />`).join('\n')
  const commands = clickCommands.map(c => `  <Button Command.Click="${c}" />`).join('\n')
  return `<?xml version="1.0" encoding="utf-8"?>\n<Prefab>\n${sources}\n${commands}\n</Prefab>\n`
}

export function buildGauntletTree() {
  rmSync(GAUNTLET_ROOT, { recursive: true, force: true })

  const put = (relPath, contents) => {
    const full = join(GAUNTLET_ROOT, ...relPath.split('/'))
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, contents, 'utf8')
  }

  // ── exact-stem target, top-level ────────────────────────────────────────────
  put('Widget.xml', uiXml(['WidgetVM', 'WidgetVM', '  SpacedVM  ', ''], ['Widget.OnClick', 'Widget.OnClick']))

  // ── ★★ THE RANKING FAMILY, DESIGNED AROUND AN OVERLAP THAT BROKE THE FIRST TWO Attempts. ──
  //
  //    getUiMatchScore takes the FIRST marker the path contains, from a list ordered
  //    ['/gui/prefabs/' (30), '/gui/' (20), '/prefabs/' (10)]. The catch: the string
  //    '/gui/prefabs/' CONTAINS '/gui/', so a file at a/gui/prefabs/X scores 30 — but if the 30
  //    entry were absent or lowered, the SAME FILE would still win at 20. Measured:
  //
  //        a/gui/prefabs/RankShared.xml   score 30   (markers matching: /gui/prefabs/=30 /gui/=20 /prefabs/=10)
  //
  //    So a corpus with only that file cannot observe the 30-vs-20 distinction: dropping the 30
  //    entry left the answer unchanged and the mutation reported OK. Two attempts were lost to
  //    this before it was measured instead of reasoned about.
  //
  //    The fix is to make the ranks MUTUALLY EXCLUSIVE: each rank's file must match its own
  //    marker and NO second marker. '/prefabs/' alone (with no /gui/ segment) and '/gui/' alone
  //    (with no prefabs below it) are both achievable; the 30-point shape unavoidably also
  //    matches '/gui/', so it is compared against a 20-point file that does NOT sit under
  //    prefabs. With the paths below:
  //        30  rank/gui/prefabs/RankShared.xml   matches /gui/prefabs/ AND /gui/
  //        20  rank/gui/RankShared.xml           matches /gui/ only
  //        10  rank/prefabs/RankShared.xml       matches /prefabs/ only
  //         0  rank/RankShared.xml               matches nothing
  //    Dropping the 30 entry now hands the win to the 20-point file; dropping /gui/ hands it to
  //    the 10-point file; every rank is load-bearing and every rank is observable.
  //    ★ AND THE TIE-BREAK CAN MASK THE RANK DIFFERENCE TOO. Dropping the 30 entry does not only
  //      change a score — it makes the 30-file and the 20-file TIE at 20, at which point
  //      localeCompare decides. With paths  'rank/gui/prefabs/...'  and  'rank/gui/...', ICU
  //      collation puts 'prefabs' before 'RankShared', so the SAME file still won and the
  //      mutation stayed invisible a THIRD time. The 30-file is therefore placed under a
  //      leading segment that sorts LAST ('z/'), and the 20-file under one that sorts FIRST
  //      ('a/'), so dropping 30 provably hands the win to the 20-file:
  //
  //        30  z/gui/prefabs/RankShared.xml   matches /gui/prefabs/ AND /gui/
  //        20  a/gui/RankShared.xml           matches /gui/ only, and sorts before the 30-file
  //        10  c/prefabs/RankShared.xml       matches /prefabs/ only
  //         0  d/RankShared.xml               matches nothing
  put('z/gui/prefabs/RankShared.xml', uiXml(['Rank30VM'], ['Rank.30']))
  put('a/gui/RankShared.xml', uiXml(['Rank20VM'], ['Rank.20']))
  put('c/prefabs/RankShared.xml', uiXml(['Rank10VM'], ['Rank.10']))
  put('d/RankShared.xml', uiXml(['Rank0VM'], ['Rank.0']))

  // ── ★★ MAKING THE EXACT-STEM BRANCH OBSERVABLE. ──────────────────────────────
  //    'Widget' has an exact match at 'Widget.xml' (score 0, top level) AND a longer prefix
  //    match at the file below (score 20). Exact-stem-first therefore picks the score-0 file;
  //    a prefix-only search would pick the score-20 one. That difference is the branch, and
  //    without this file the exact/prefix distinction is invisible to every query.
  put('a/gui/WidgetExtra.xml', uiXml(['WidgetExtraVM'], ['WidgetExtra.Close']))

  // ── ★ THE SCORED RANKS, one file each, so each marker is reachable on its own. Paths are
  //    again mutually exclusive: each matches its own marker and nothing else. ──
  // 30: contains '/gui/prefabs/'
  put('z/gui/prefabs/PanelPrefab.xml', uiXml(['PanelPrefabVM'], ['PanelPrefab.Close']))
  // 20: contains '/gui/' but not '/gui/prefabs/'
  put('a/gui/PanelGui.xml', uiXml(['PanelGuiVM'], ['PanelGui.Close']))
  // 10: contains '/prefabs/' but not '/gui/'
  put('c/prefabs/PanelBare.xml', uiXml(['PanelBareVM'], ['PanelBare.Close']))
  // 0: an unmatched path (no marker at all) — the branch a relative scan always hits
  put('d/PanelPlain.xml', uiXml(['PanelPlainVM'], ['PanelPlain.Close']))

  // ── the RELATIVE shapes, kept so the measured "no marker matches" branch is pinned too.
  //    'gui/PanelRel.xml' scores 0 despite starting with gui/, which is exactly the trap. ──
  put('gui/PanelRel.xml', uiXml(['PanelRelVM'], ['PanelRel.Close']))
  put('prefabs/PanelRelBare.xml', uiXml(['PanelRelBareVM'], ['PanelRelBare.Close']))

  // ── a TIE at the same score, so localeCompare decides: both under a /gui/ segment and
  //    both matching the query by exact stem. Neither contains '/gui/prefabs/'. ──
  put('tie1/gui/alpha/TieExample.xml', uiXml(['TieAlphaVM'], ['Tie.Alpha']))
  put('tie1/gui/beta/TieExample.xml', uiXml(['TieBetaVM'], ['Tie.Beta']))

  // ── case-folded stem lookup target ──────────────────────────────────────────
  put('a/gui/MixedCase.xml', uiXml(['MixedCaseVM'], ['MixedCase.Close']))

  // ── a deep nested file, to prove the walk is recursive ──────────────────────
  put('a/gui/deep/a/b/c/DeepWidget.xml', uiXml(['DeepVM'], ['Deep.Close']))

  // ── a non-XML file that must be ignored by the glob ─────────────────────────
  put('a/gui/notes.txt', 'not xml at all, DataSource="{ShouldNotAppear}"')

  // ── an XML file with no data sources or commands at all ─────────────────────
  put('a/gui/Empty.xml', '<?xml version="1.0" encoding="utf-8"?>\n<Prefab />\n')

  // ── an XML file whose stem is exactly the extension ─────────────────────────
  put('a/gui/.xml', uiXml(['OddVM'], ['Odd.Close']))

  return GAUNTLET_ROOT
}
