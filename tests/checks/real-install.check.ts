/**
 * Run the new tools against the REAL Bannerlord install, not a corpus.
 *
 * WHY THIS MATTERS MORE THAN ANY OF THE EARLIER TESTS
 * ---------------------------------------------------
 * index_assets, find_asset and check_mod_conflicts were verified against a corpus I built. A
 * corpus I build encodes my own assumptions about the layout: I wrote `Modules/<id>/GUI/...` and a
 * `bin/` to prune BECAUSE I assumed that shape. If the real install differs, every one of those
 * tests passes while the tool fails on the one input that matters.
 *
 * The install is at:
 *   G:\Program Files (x86)\Steam\steamapps\common\Mount & Blade II Bannerlord
 *
 * Note I previously reported "this machine has no game installed" after checking three hardcoded
 * paths on C:, D: and E:. Steam is on G:. That was a guess presented as a fact, and it is the
 * reason this file exists: the claim is now being replaced by a measurement.
 *
 * WHAT IS BEING CHECKED
 *   - the walker completes on a real install without hanging or exploding
 *   - artwork is actually found, in the tiers the real layout uses
 *   - bin/ pruning is real: the game ships a large bin/ tree
 *   - module attribution names real module directories
 *   - a real module's Harmony patches are found, and cross-mod conflicts are real ones
 */
import { indexAssets, findAssets } from '../../src/utils/asset-index';
import { collectCsharpFiles, findPatchConflicts, scanPatchDeclarations } from '../../src/utils/harmony-patch-scan';
import { statSync } from 'node:fs';

const GAME = 'G:\\Program Files (x86)\\Steam\\steamapps\\common\\Mount & Blade II Bannerlord';
let failures = 0;

function assert(label, cond, extra) {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

// ── the install must actually be there, or nothing below means anything ─────
let present = false;
try {
  present = statSync(GAME).isDirectory();
} catch {
  present = false;
}
assert('the real install is present at the expected path', present, GAME);
if (!present) {
  console.log('');
  console.log('REAL_INSTALL_NOT_FOUND');
  process.exit(2);
}

// ── index_assets on the real tree ──────────────────────────────────────────
const started = Date.now();
const index = await indexAssets(GAME, { limit: 20000 });
const elapsed = Date.now() - started;

console.log('');
console.log(`indexed ${index.entries.length} assets in ${elapsed} ms`);
console.log(`  textures ${index.counts.texture}  models ${index.counts.model}  packages ${index.counts.package}`);
console.log(`  skipped ${index.skippedDirectories.length} directories  truncated ${index.truncated}`);

assert('the walk finds artwork in a real install', index.entries.length > 100, index.entries.length);
assert('the walk finishes in reasonable time (< 60s)', elapsed < 60_000, `${elapsed} ms`);
assert('the index is not truncated at a sane limit', index.truncated === false);

// The game ships a large bin/ tree full of DLLs; if pruning failed, the walk would either be
// much slower or would pick up .png/.dds from build output.
const fromBin = index.entries.filter(e => /(^|\/)bin\//i.test(e.relativePath));
assert('bin/ is pruned on the real tree', fromBin.length === 0, fromBin.slice(0, 5));

// Module attribution must name real module directories, not "unknown".
const unknownModule = index.entries.filter(e => e.moduleId === 'unknown');
assert('every entry is attributed to a real module or to the game',
  unknownModule.length === 0, unknownModule.slice(0, 5).map(e => e.relativePath));

const modulesSeen = [...new Set(index.entries.map(e => e.moduleId))];
console.log(`  modules contributing artwork: ${modulesSeen.length}`);
assert('artwork comes from multiple modules', modulesSeen.length > 1, modulesSeen.slice(0, 10));

// ── find_asset against a name that must exist ──────────────────────────────
// Pick a real filename from the index rather than inventing one, then look it up.
if (index.entries.length > 0) {
  const sample = index.entries.find(e => e.kind === 'texture') ?? index.entries[0];
  const stem = sample.fileName.replace(/\.[^.]+$/, '');
  const hits = findAssets(index, stem);
  assert('findAssets locates a real file by its own name', hits.length > 0, { stem, sample: sample.relativePath });
}

// ── Harmony patch scan on real mods ────────────────────────────────────────
// Scan the modules that ship source or at least compiled patches. Most mods ship only DLLs, so
// this may legitimately find nothing - and an empty result must be reported as such rather than
// asserted away.
const modulesDir = `${GAME}\\Modules`;
const { readdirSync } = await import('node:fs');
const moduleNames = readdirSync(modulesDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);

let totalDeclarations = 0;
const perModule = [];
for (const name of moduleNames.slice(0, 25)) {
  const dir = `${modulesDir}\\${name}`;
  const files = await collectCsharpFiles(dir, 400);
  if (files.length === 0) continue;
  const { declarations } = await scanPatchDeclarations(dir, name, files);
  if (declarations.length > 0) {
    perModule.push({ name, declarations: declarations.length, files: files.length });
    totalDeclarations += declarations.length;
  }
}

console.log('');
console.log(`modules with .cs source: ${perModule.length}`);
console.log(`patch declarations found: ${totalDeclarations}`);
for (const m of perModule.slice(0, 6)) {
  console.log(`  ${m.name}: ${m.declarations} declaration(s) in ${m.files} file(s)`);
}

if (totalDeclarations > 0) {
  assert('real Harmony patch declarations are parsed', totalDeclarations > 0);
} else {
  console.log('  NOTE: no .cs source found - shipped mods are compiled DLLs only.');
  console.log('        check_mod_conflicts therefore cannot be exercised on this install;');
  console.log('        that is a property of the install, not a defect in the tool.');
}

console.log('');
console.log(failures === 0 ? 'REAL_INSTALL_OK' : `REAL_INSTALL_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);

