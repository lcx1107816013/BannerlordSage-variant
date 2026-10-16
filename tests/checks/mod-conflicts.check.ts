/**
 * Behaviour tests for static multi-mod Harmony patch conflict analysis.
 *
 * EACH ASSERTION PINS A RULE THAT COULD PLAUSIBLY BE WRITTEN WRONG, and several of them are
 * rules I got wrong on the first attempt:
 *
 *   - `nameof(Hero.CanBecomePrisoner)` MUST be parsed. This is the form the project's own
 *     mod-workspace template emits, and a regex that only accepts quoted strings would miss
 *     every mod using the idiom the engine docs recommend - reporting "no conflicts" for a
 *     corpus full of them.
 *   - a type-only patch and a method patch on the same type are DIFFERENT targets. Merging
 *     them would manufacture conflicts that do not exist.
 *   - two patching methods inside ONE mod is not a multi-mod conflict.
 *   - severity ORDER is the point: transpiler-vs-transpiler is reported above plain
 *     prefix/postfix overlap, because the failure modes differ (invalid IL versus a wrong
 *     result) and a modder needs to know which to look at first.
 *   - a single-mod run must SAY it cannot answer a cross-mod question, rather than return an
 *     empty conflict list that reads like a clean bill of health.
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  collectCsharpFiles,
  findPatchConflicts,
  parseHarmonyPatchArguments,
  scanPatchDeclarations,
  splitTopLevel,
} from '../../src/utils/harmony-patch-scan';
import { checkModConflicts } from '../../src/tools/check-mod-conflicts';

const root = mkdtempSync(join(tmpdir(), 'patch-scan-'));
let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

function put(rel: string, body: string): void {
  const full = join(root, ...rel.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

try {
  // ── the argument parser handles every shape that occurs in real mods ──────
  assert('typeof + quoted string',
    parseHarmonyPatchArguments('typeof(Hero), "CanBecomePrisoner"').targetMethod === 'CanBecomePrisoner');
  assert('typeof + nameof',
    parseHarmonyPatchArguments('typeof(Hero), nameof(Hero.CanBecomePrisoner)').targetMethod === 'CanBecomePrisoner');
  assert('typeof forms still give the method',
    parseHarmonyPatchArguments('typeof(TaleWorlds.CampaignSystem.Hero), nameof(TaleWorlds.CampaignSystem.Hero.Name)').targetType
      === 'TaleWorlds.CampaignSystem.Hero');
  assert('string type name',
    parseHarmonyPatchArguments('"Hero", "CanBecomePrisoner"').targetType === 'Hero');
  assert('type-only attribute',
    parseHarmonyPatchArguments('typeof(Hero)').targetType === 'Hero'
    && parseHarmonyPatchArguments('typeof(Hero)').targetMethod === '');
  assert('an overload list does not confuse the method',
    parseHarmonyPatchArguments('typeof(Hero), "M", new Type[] { typeof(int) }').targetMethod === 'M');

  // ── comma splitting respects nesting ─────────────────────────────────────
  assert('splitTopLevel splits on top-level commas only',
    splitTopLevel('typeof(Hero), "M", new Type[] { typeof(int), typeof(string) }').length === 3);
  assert('splitTopLevel ignores commas inside a generic',
    splitTopLevel('typeof(Dictionary<int, string>)').length === 1);

  // ── the corpus: two mods that genuinely compete, plus one that does not ──
  put('ModA/Patches/A.cs', `
using HarmonyLib;
[HarmonyPatch(typeof(Hero), nameof(Hero.CanBecomePrisoner))]
[HarmonyPrefix]
class APatch { static bool Pre() => true; }
`);
  put('ModB/Patches/B.cs', `
using HarmonyLib;
[HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]
[HarmonyTranspiler]
class BPatch { static void T() { } }
`);
  put('ModC/Patches/C.cs', `
using HarmonyLib;
[HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]
[HarmonyTranspiler]
class CPatch { static void T() { } }
`);
  put('ModD/Patches/D.cs', `
using HarmonyLib;
[HarmonyPatch(typeof(Settlement))]
[HarmonyPostfix]
class DPatch { static void Post() { } }
`);
  // Two patching classes in ONE mod: that mod's business, not a cross-mod conflict.
  put('ModE/Patches/E1.cs', 'using HarmonyLib;\n[HarmonyPatch(typeof(Item), "GetValue")]\n[HarmonyPrefix]\nclass E1 { }');
  put('ModE/Patches/E2.cs', 'using HarmonyLib;\n[HarmonyPatch(typeof(Item), "GetValue")]\n[HarmonyPostfix]\nclass E2 { }');
  // Build output must not be scanned.
  put('ModA/bin/Debug/A.cs', 'using HarmonyLib;\n[HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]\n[HarmonyTranspiler]\nclass Ghost { }');
  put('ModA/obj/A.cs', 'using HarmonyLib;\n[HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]\n[HarmonyTranspiler]\nclass Ghost2 { }');

  const mods = ['ModA', 'ModB', 'ModC', 'ModD', 'ModE'].map(m => join(root, m));
  const result = await checkModConflicts({ modDirs: mods, includeDeclarations: true });
  const text = textOf(result);

  assert('conflicts are reported', text.includes('conflict_count: 1'), text.slice(0, 400));
  assert('a transpiler clash is identified', text.includes('transpiler_clash'), text);
  // ★ ALL THREE owners, INCLUDING ModA. My first assertion expected only ModB and ModC,
  // because I was thinking of the transpiler owners - but ModA patches the same method with a
  // prefix, so it genuinely competes for that target and belongs in the list. The tool was
  // right and the assertion was wrong; the fix is the assertion. (That ModA's target is
  // written as `nameof(...)` and still appears here is also what proves the parser handles the
  // idiom the engine docs recommend.)
  assert('every competing owner is named, including the prefix owner',
    text.includes('owners: ModA, ModB, ModC'), text);
  assert('a transpiler clash requires two TRANSPILER owners, counted separately from the rest',
    text.includes('transpiler_clashes: 1'), text.slice(0, 300));
  assert('the type-only target is NOT merged with the method target',
    !text.includes('Settlement.CanBecomePrisoner'), text);
  // ★ `includeDeclarations: true` LISTS Item.GetValue, so a plain "not in the text" check is
  // wrong - the assertion has to be about the CONFLICT LIST, not about the whole report. Two
  // patching classes inside ModE are that mod's own business; what must not happen is that
  // they get reported as a multi-mod conflict.
  const conflictSection = text.slice(
    text.indexOf('conflicts:'),
    text.indexOf('per_module:'),
  );
  assert('a single-mod double patch is not a cross-mod conflict',
    !conflictSection.includes('Item.GetValue'), conflictSection);
  assert('that patch is still visible as a declaration (not hidden)',
    text.includes('Item.GetValue'), text);
  assert('evidence lines carry file and line',
    /ModB: Patches\/B\.cs:\d+/.test(text), text);
  assert('build output is not scanned',
    !text.includes('bin/Debug') && !text.includes('obj/'), text);
  assert('the boundary is stated',
    text.includes('no game was started'), text);
  assert('the report points at the runtime tool for confirmation',
    text.includes('bl_patches'), text);

  // ── the parser is what makes transpiler detection work ───────────────────
  const bFiles = await collectCsharpFiles(join(root, 'ModB'));
  const { declarations } = await scanPatchDeclarations(join(root, 'ModB'), 'ModB', bFiles);
  assert('a quoted-string target is parsed', declarations.length === 1 && declarations[0].targetMethod === 'CanBecomePrisoner');
  assert('the transpiler kind is attributed', declarations[0].kinds.includes('transpiler'));

  const aFiles = await collectCsharpFiles(join(root, 'ModA'));
  const aScan = await scanPatchDeclarations(join(root, 'ModA'), 'ModA', aFiles);
  assert('a nameof target is parsed',
    aScan.declarations.length === 1 && aScan.declarations[0].targetMethod === 'CanBecomePrisoner',
    aScan.declarations);

  // ── severity ordering ────────────────────────────────────────────────────
  const synthetic = findPatchConflicts([
    { moduleId: 'X', filePath: 'a', line: 1, targetType: 'T', targetMethod: 'm', kinds: ['prefix'] },
    { moduleId: 'Y', filePath: 'b', line: 1, targetType: 'T', targetMethod: 'm', kinds: ['postfix'] },
    { moduleId: 'P', filePath: 'c', line: 1, targetType: 'U', targetMethod: 'n', kinds: ['transpiler'] },
    { moduleId: 'Q', filePath: 'd', line: 1, targetType: 'U', targetMethod: 'n', kinds: ['transpiler'] },
  ]);
  assert('a transpiler clash sorts above a prefix/postfix overlap',
    synthetic[0]?.severity === 'transpiler_clash', synthetic.map(c => c.severity));
  assert('both conflicts are found', synthetic.length === 2, synthetic.length);

  // ★ A NEGATIVE CONTROL CAUGHT A HOLE HERE. Loosening the severity rule from "two
  // TRANSPILER owners" to "two owners of any kind" changed NOTHING in the test result,
  // because the corpus had no target where one owner transpiles and the other does not.
  // A rule that cannot be observed is not tested, so this case exists: two owners on one
  // target, exactly one of them a transpiler. That must grade as a plain overlap, not a
  // clash - the whole distinction between "invalid IL" and "a wrong result" rests on it.
  const mixed = findPatchConflicts([
    { moduleId: 'R', filePath: 'e', line: 1, targetType: 'V', targetMethod: 'o', kinds: ['transpiler'] },
    { moduleId: 'S', filePath: 'f', line: 1, targetType: 'V', targetMethod: 'o', kinds: ['prefix'] },
  ]);
  assert('ONE transpiler among several owners is NOT a transpiler clash',
    mixed[0]?.severity === 'prefix_postfix_overlap', mixed.map(c => c.severity));

  const finalizer = findPatchConflicts([
    { moduleId: 'F1', filePath: 'g', line: 1, targetType: 'W', targetMethod: 'p', kinds: ['finalizer'] },
    { moduleId: 'F2', filePath: 'h', line: 1, targetType: 'W', targetMethod: 'p', kinds: ['postfix'] },
  ]);
  assert('a finalizer shared across owners grades as finalizer overlap',
    finalizer[0]?.severity === 'finalizer_overlap', finalizer.map(c => c.severity));

  // ── refusal and boundary paths ───────────────────────────────────────────
  const none = await checkModConflicts({ modDirs: [] });
  assert('no modDirs is an error, not an empty success',
    textOf(none).includes('modDirs must contain at least one directory'), textOf(none));

  const one = await checkModConflicts({ modDirs: [mods[0]] });
  assert('a single mod says it cannot answer a cross-mod question',
    textOf(one).includes('only one mod given'), textOf(one));

  const missing = await checkModConflicts({ modDirs: [mods[0], join(root, 'nope')] });
  assert('an unreadable module is named, not silently dropped',
    textOf(missing).includes('NOT READABLE'), textOf(missing).slice(0, 400));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'MOD_CONFLICTS_OK' : `MOD_CONFLICTS_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);
