/**
 * Behaviour tests for the asset index — the first asset-side capability in the archive.
 *
 * WHY A BUILT CORPUS RATHER THAN THE REAL INSTALL: this machine has no Bannerlord install,
 * and a test that skips when a game is absent would pass forever without testing anything.
 * The tree below is constructed to hit each decision the walker makes, so the assertions are
 * about the walker's rules rather than about someone's disk.
 *
 * EACH ASSERTION NAMES A RULE THAT COULD PLAUSIBLY BE WRITTEN WRONG:
 *   - `bin/` is PRUNED. A mod repo's bin/ holds build output, and an early version of the
 *     walker spent minutes inside it. Pruning is a decision, so it gets a test.
 *   - `.git` is PRUNED, and the skip list records it - a count that looks too low should have
 *     a visible reason, not a silent one.
 *   - extension matching is CASE-INSENSITIVE. Game assets ship as `.DDS` in some packs.
 *   - a non-art extension (`.xml`) is not collected, so the index is not just "every file".
 *   - `limit` truncates AND says so. A truncated index that reports as complete is worse
 *     than no index, because callers cannot tell they are looking at a partial answer.
 *   - per-module attribution: an entry under Modules/Foo names Foo, not the install root.
 *   - a loose top-level `GUI/` tree is collected even with no Modules/ directory.
 *   - `findAssets` matches filename, path and module id, case-insensitively.
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  indexAssets,
  findAssets,
  TEXTURE_EXTENSIONS,
  MODEL_EXTENSIONS,
  PACKAGE_EXTENSIONS,
} from '../../src/utils/asset-index';

const root = mkdtempSync(join(tmpdir(), 'asset-index-'));
let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra));
  }
}

function put(rel: string, bytes = 'x'): void {
  const full = join(root, ...rel.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, bytes);
}

try {
  // ── a module tree with the extensions that matter, in mixed case ──────────
  put('Modules/Native/AssetPackages/Core.tpac', 't'.repeat(64));
  put('Modules/Native/GUI/Textures/Banner.DDS', 'd'.repeat(128));
  put('Modules/Native/GUI/Textures/banner.png', 'p'.repeat(32));
  put('Modules/Native/GUI/Meshes/shield.mesh', 'm'.repeat(16));
  put('Modules/Native/ModuleData/items.xml', '<xml/>');
  put('Modules/Native/ModuleData/notes.txt', 'not art');

  // ── must be pruned ───────────────────────────────────────────────────────
  put('Modules/Native/bin/Debug/Build.dds', 'b'.repeat(8));
  put('Modules/Native/.git/objects/loose.dds', 'g'.repeat(8));
  put('Modules/Native/node_modules/pkg/thing.tpac', 'n'.repeat(8));

  // ── a second module, so per-module attribution is testable ───────────────
  put('Modules/MercenaryGuild/GUI/Textures/guild.tga', 't'.repeat(24));

  // ── loose install-level art, outside any module ──────────────────────────
  put('GUI/Textures/Install.png', 'i'.repeat(12));

  const index = await indexAssets(root, { limit: 200 });

  assert('texture files are collected', index.counts.texture === 4, index.counts);
  assert('model files are collected', index.counts.model === 1, index.counts);
  assert('package files are collected', index.counts.package === 1, index.counts);
  assert('the index is not reported as truncated', index.truncated === false);

  const names = index.entries.map(e => e.fileName.toLowerCase());
  assert('uppercase .DDS is collected (case-insensitive matching)', names.includes('banner.dds'), names);
  assert('lowercase .png is collected', names.includes('banner.png'), names);
  assert('.mesh is collected', names.includes('shield.mesh'), names);
  assert('non-art extensions are NOT collected', !names.includes('items.xml') && !names.includes('notes.txt'), names);

  assert('bin/ is pruned', !names.includes('build.dds'), names);
  assert('.git is pruned', !names.includes('loose.dds'), names);
  assert('node_modules is pruned', !names.includes('thing.tpac'), names);
  assert('pruned directories are REPORTED, not silently dropped',
    index.skippedDirectories.some(p => p.includes('bin')) && index.skippedDirectories.some(p => p.includes('.git')),
    index.skippedDirectories);

  const banner = index.entries.find(e => e.fileName === 'Banner.DDS');
  assert('an entry names its module, not the install root', banner?.moduleId === 'Native', banner?.moduleId);
  const guild = index.entries.find(e => e.fileName === 'guild.tga');
  assert('a second module is attributed to itself', guild?.moduleId === 'MercenaryGuild', guild?.moduleId);
  const loose = index.entries.find(e => e.fileName === 'Install.png');
  assert('loose install-level art is still collected', loose !== undefined);
  // ★ THE FIRST VERSION MISSED THIS AND THE ASSERTION ABOVE CAUGHT IT. Every walk started
  // inside Modules/, so artwork the game itself ships at the install root was invisible. The
  // module id is asserted too: 'game' says which tree it came from, where 'unknown' would
  // read as "the walker lost track".
  assert('install-level art is attributed to the game, not to an unknown module',
    loose?.moduleId === 'game', loose?.moduleId);

  assert('relative paths use forward slashes',
    index.entries.every(e => !e.relativePath.includes('\\')), index.entries[0]?.relativePath);

  // ── truncation must be announced ─────────────────────────────────────────
  const small = await indexAssets(root, { limit: 3 });
  assert('limit truncates the result', small.entries.length === 3, small.entries.length);
  assert('truncation is REPORTED', small.truncated === true);

  // ── module scoping ───────────────────────────────────────────────────────
  const onlyGuild = await indexAssets(root, { moduleId: 'MercenaryGuild', limit: 200 });
  assert('moduleId scopes the walk',
    onlyGuild.entries.length > 0 && onlyGuild.entries.every(e => e.moduleId === 'MercenaryGuild'),
    onlyGuild.entries.map(e => e.moduleId));

  // ── a tree with no Modules/ at all ───────────────────────────────────────
  const bare = mkdtempSync(join(tmpdir(), 'asset-bare-'));
  writeFileSync(join(bare, 'Flat.dds'), 'f'.repeat(4));
  const bareIndex = await indexAssets(bare, { limit: 50 });
  assert('a tree with no Modules/ directory is still walked',
    bareIndex.entries.some(e => e.fileName === 'Flat.dds'), bareIndex.entries.map(e => e.fileName));
  rmSync(bare, { recursive: true, force: true });

  // ── findAssets ───────────────────────────────────────────────────────────
  assert('findAssets matches by filename', findAssets(index, 'shield').length === 1);
  assert('findAssets is case-insensitive', findAssets(index, 'SHIELD').length === 1);
  assert('findAssets matches by module id', findAssets(index, 'mercenaryguild').length === 1);
  assert('findAssets matches by path fragment', findAssets(index, 'gui/textures').length >= 3);
  assert('findAssets returns nothing for an empty query', findAssets(index, '   ').length === 0);
  assert('findAssets returns nothing for a miss', findAssets(index, 'zzz-nope').length === 0);

  // ── the extension lists are the ones the walker uses ─────────────────────
  assert('texture list covers dds and png',
    (TEXTURE_EXTENSIONS as readonly string[]).includes('.dds')
    && (TEXTURE_EXTENSIONS as readonly string[]).includes('.png'));
  assert('model list covers mesh', (MODEL_EXTENSIONS as readonly string[]).includes('.mesh'));
  assert('package list covers tpac', (PACKAGE_EXTENSIONS as readonly string[]).includes('.tpac'));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'ASSET_INDEX_OK' : `ASSET_INDEX_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);
