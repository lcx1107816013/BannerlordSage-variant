/**
 * Regression test for the symlink blind spot — the defect that a corpus could not catch.
 *
 * WHAT WENT WRONG, TWICE
 * ----------------------
 * The asset walker used `if (!dirent.isFile()) continue`. On a real install, Vortex deploys mods as
 * SYMLINKS, and Node's Dirent reports a symlink as neither a file nor a directory — so every
 * deployed asset was dropped. Measured on the real install: 9 of 12 art-bearing modules vanished
 * while the aggregate count still looked healthy, because the base game's real files carried it.
 *
 * Then the first fix made it worse (1628 -> 1) by classifying the extension BEFORE following the
 * link, so directories named `GUI`/`Assets` hit the not-an-asset `continue` and never got walked.
 *
 * ★ WHY THIS TEST CANNOT BE REPLACED BY THE EXISTING CORPUS TESTS: those use `writeFileSync`, which
 * creates real files. A corpus built from an assumption about how files are stored will never
 * exercise the storage mechanism. So this test CREATES A REAL SYMLINK (directory symlink where the
 * platform allows it, file symlink otherwise) and asserts both halves:
 *
 *   - a symlinked FILE is collected
 *   - a symlinked DIRECTORY is descended into, not skipped as a non-asset
 *
 * Windows needs Developer Mode or elevation for symlinks. When it is unavailable the test reports
 * SKIP with the reason rather than passing silently - a green result that never ran is the exact
 * failure mode this project keeps recording.
 */
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexAssets } from '../../src/utils/asset-index';

const root = mkdtempSync(join(tmpdir(), 'symlink-asset-'));
let failures = 0;
let skipped = 0;

function assert(label: string, cond: boolean, extra?: unknown): void {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

function skip(label: string, why: string): void {
  skipped++;
  console.log(`SKIP ${label} — ${why}`);
}

/** Creates a symlink, returning false when the platform refuses (no privilege). */
function trySymlink(target: string, linkPath: string, type: 'file' | 'dir' | 'junction'): boolean {
  try {
    symlinkSync(target, linkPath, type);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES' || code === 'ENOSYS') return false;
    throw error;
  }
}

try {
  // ── a module whose artwork is a SYMLINKED FILE ──────────────────────────
  // This is the Vortex layout: the real file lives elsewhere, the module dir holds a link.
  const outside = join(root, 'vortex-deploy', 'RealMod', 'Assets');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'linked.tpac'), 'tpac-bytes');

  const modDir = join(root, 'Modules', 'LinkedMod', 'Assets');
  mkdirSync(modDir, { recursive: true });

  const fileLinkOk = trySymlink(join(outside, 'linked.tpac'), join(modDir, 'linked.tpac'), 'file');

  // ── a module whose artwork DIR closes over a SYMLINKED DIRECTORY ────────
  // The second half of the bug: a directory symlink must be descended into, not treated as
  // "not an asset" and skipped.
  const outsideDir = join(root, 'vortex-deploy', 'RealMod', 'GUI', 'Textures');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(outsideDir, 'inside.png'), 'png-bytes');

  const guiDir = join(root, 'Modules', 'LinkedMod', 'GUI');
  mkdirSync(guiDir, { recursive: true });
  const dirLinkOk = trySymlink(outsideDir, join(guiDir, 'Textures'), process.platform === 'win32' ? 'junction' : 'dir');

  // ── a real file alongside them, so the baseline is known good ───────────
  const realDir = join(root, 'Modules', 'RealMod', 'Assets');
  mkdirSync(realDir, { recursive: true });
  writeFileSync(join(realDir, 'real.tpac'), 'real-bytes');

  const index = await indexAssets(root, { limit: 500 });
  const names = index.entries.map(e => e.fileName.toLowerCase());

  console.log('');
  console.log(`indexed ${index.entries.length}: ${index.entries.map(e => e.fileName).join(', ')}`);
  console.log(`brokenLinks: ${index.brokenLinks.length}`);
  console.log('');

  assert('a plain file is collected (baseline)', names.includes('real.tpac'), names);

  // ★ WHEN THE PLATFORM REFUSES SYMLINKS, FALL BACK TO A REAL ONE.
  //
  // This machine has no symlink privilege (no Developer Mode, not elevated), so the local corpus
  // cannot create a file symlink. But the machine HAS a real Vortex-deployed install whose mod
  // assets are symlinks - which is stronger evidence than anything a temp directory could provide.
  // Asserting against that turns an unavailable skip into a real check.
  //
  // The install path is not hardcoded as a requirement: if it is absent, the file-symlink case
  // stays a documented skip rather than becoming a failure on machines that never had the game.
  const REAL_GAME = 'G:\\Program Files (x86)\\Steam\\steamapps\\common\\Mount & Blade II Bannerlord';

  if (fileLinkOk) {
    assert('a SYMLINKED file is collected', names.includes('linked.tpac'), names);
    const linked = index.entries.find(e => e.fileName.toLowerCase() === 'linked.tpac');
    assert('a symlinked file reports its target size, not 0',
      (linked?.sizeBytes ?? 0) > 0, linked?.sizeBytes);
  } else {
    let hasReal = false;
    try {
      hasReal = statSync(REAL_GAME).isDirectory();
    } catch {
      hasReal = false;
    }

    if (hasReal) {
      const realIndex = await indexAssets(REAL_GAME, { limit: 20000 });
      const realNames = new Set(realIndex.entries.map(e => e.fileName.toLowerCase()));

      // These files are confirmed symlinks on disk (Attributes: Archive, ReparsePoint; Length 0).
      assert('a REAL Vortex-deployed symlinked asset is collected',
        realNames.has('a1_geo.tpac'), { total: realIndex.entries.length });

      const linked = realIndex.entries.find(e => e.fileName.toLowerCase() === 'a1_geo.tpac');
      assert('a real symlinked asset reports its target size, not 0',
        (linked?.sizeBytes ?? 0) > 0, linked?.sizeBytes);

      // The aggregate must reflect every art-bearing module, not just the base game.
      const modules = new Set(realIndex.entries.map(e => e.moduleId));
      assert('deployed mods are represented, not only the base game',
        modules.size >= 10, [...modules].slice(0, 12));

      console.log(`  (verified against the real install: ${realIndex.entries.length} entries across ${modules.size} modules)`);
    } else {
      skip('a SYMLINKED file is collected',
        'no symlink privilege AND no real install to fall back to');
    }
  }

  if (dirLinkOk) {
    assert('a SYMLINKED directory is descended into', names.includes('inside.png'), names);
  } else {
    skip('a SYMLINKED directory is descended into', 'no symlink privilege');
  }

  // ── a broken link must be recorded, not silently dropped ────────────────
  const brokenPath = join(root, 'Modules', 'LinkedMod', 'Assets', 'gone.tpac');
  const brokenOk = trySymlink(join(root, 'does-not-exist.tpac'), brokenPath, 'file');
  if (brokenOk) {
    const second = await indexAssets(root, { limit: 500 });
    assert('a broken link is reported rather than dropped', second.brokenLinks.length > 0, {
      brokenLinks: second.brokenLinks.length,
    });
  } else {
    skip('a broken link is reported', 'no symlink privilege');
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
if (failures > 0) {
  console.log(`SYMLINK_ASSETS_FAILED_${failures}`);
  process.exit(1);
}
console.log(skipped > 0 ? `SYMLINK_ASSETS_OK (${skipped} skipped - no symlink privilege)` : 'SYMLINK_ASSETS_OK');
