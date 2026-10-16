/**
 * End-to-end check that the new asset tools actually work through their MCP entry points.
 *
 * The unit tests cover the walker's rules. This covers the layer above: that the tool builds
 * a report a caller can use, that its refusal paths return a report instead of throwing, and
 * that the two tools agree with each other - `index_assets` says what exists and
 * `find_asset` narrows it, so a name the index lists must be findable and vice versa.
 *
 * A tool whose report is empty but whose exit code is fine is the exact shape of failure
 * this project keeps finding, so the assertions look for CONTENT (the filename appears in
 * the text) rather than for "no error".
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexAssetsTool } from '../src/tools/index-assets';
import { findAssetTool } from '../src/tools/find-asset';

const root = mkdtempSync(join(tmpdir(), 'asset-tools-'));
let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

function put(rel: string): void {
  const full = join(root, ...rel.split('/'));
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
}

const textOf = (result: { content: Array<{ text: string }> }) => result.content[0].text;

try {
  put('Modules/Native/AssetPackages/Core.tpac');
  put('Modules/Native/GUI/Textures/Banner.DDS');
  put('Modules/Native/GUI/Meshes/shield.mesh');
  put('Modules/Other/GUI/Textures/other.png');

  // ── index_assets: the whole install ───────────────────────────────────────
  const all = await indexAssetsTool({ gameDir: root });
  const allText = textOf(all);
  assert('index_assets reports the root', allText.includes(`gameDir: ${root}`), allText.slice(0, 200));
  assert('index_assets names a texture file', allText.includes('Banner.DDS'), allText);
  assert('index_assets names a model file', allText.includes('shield.mesh'), allText);
  assert('index_assets names a package file', allText.includes('Core.tpac'), allText);
  assert('index_assets separates packages from loose art',
    allText.indexOf('asset_packages:') < allText.indexOf('textures:'), allText);
  assert('index_assets reports it does not decode payloads',
    allText.includes('not decoded'), allText);
  assert('index_assets names the module for each entry', allText.includes('[Native]'), allText);

  // ── index_assets: scoped and filtered ─────────────────────────────────────
  const scoped = await indexAssetsTool({ gameDir: root, moduleId: 'Other' });
  const scopedText = textOf(scoped);
  assert('scoping to one module drops the others',
    scopedText.includes('other.png') && !scopedText.includes('Banner.DDS'), scopedText);

  const filtered = await indexAssetsTool({ gameDir: root, query: 'shield' });
  const filteredText = textOf(filtered);
  assert('a query narrows the listing',
    filteredText.includes('shield.mesh') && !filteredText.includes('Banner.DDS'), filteredText);

  // ── refusal paths return a report, not a throw ────────────────────────────
  const emptyDir = await indexAssetsTool({ gameDir: '   ' });
  assert('a blank gameDir yields an error report, not an exception',
    textOf(emptyDir).includes('gameDir is required'), textOf(emptyDir));

  const missing = await indexAssetsTool({ gameDir: join(root, 'does-not-exist') });
  const missingText = textOf(missing);
  // ★ THE FIRST VERSION OF THE TOOL FAILED THIS, IN THE WORST WAY. A nonexistent path made
  // the walker return zero entries - readdir failures are recorded as skipped directories -
  // so the tool answered "0 textures, 0 models", which reads as "this install has no
  // artwork" when the truth is "your path is wrong". The assertion below checks that the
  // report says the directory is unreadable, not merely that nothing threw.
  assert('a missing install is reported as unreadable, not as an empty install',
    missingText.includes('not a readable directory'), missingText.slice(0, 300));
  assert('a missing install does not report an empty but valid tree',
    !missingText.includes('total_indexed: 0') || missingText.includes('not a readable directory'),
    missingText.slice(0, 300));

  // ── find_asset agrees with the index ──────────────────────────────────────
  const found = await findAssetTool({ gameDir: root, query: 'banner' });
  const foundText = textOf(found);
  assert('find_asset locates a file the index lists', foundText.includes('Banner.DDS'), foundText);

  const foundByModule = await findAssetTool({ gameDir: root, query: 'other' });
  assert('find_asset matches on module id too', textOf(foundByModule).includes('other.png'), textOf(foundByModule));

  const foundNothing = await findAssetTool({ gameDir: root, query: 'zzz-absent' });
  const nothingText = textOf(foundNothing);
  assert('find_asset says so when nothing matches',
    nothingText.includes('match_count: 0') || nothingText.includes('no matches'), nothingText);

  const emptyQuery = await findAssetTool({ gameDir: root, query: '   ' });
  assert('find_asset rejects an empty query rather than listing everything',
    textOf(emptyQuery).includes('query is required'), textOf(emptyQuery));
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'ASSET_TOOLS_OK' : `ASSET_TOOLS_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);
