// F19: mod-source workspaces carry a schema-version marker so a cache can be
// identified as OURS before anything deletes it.
//
// THE HAZARD, STATED PRECISELY
// ----------------------------
// `getModSourcePaths` derives the workspace directory from sha1(sourcePath), so a
// path always maps to the same folder. 18 folders on this machine hold a 3-column
// `csharp_files` (no `indexedAt`); the current code writes 4. A cleanup routine that
// enumerates `dist/mod-sources/*` therefore cannot tell "our current cache" from
// "an older cache someone may still need" — it can only see that a directory exists.
//
// Measured today: none of the 64 source paths this code can actually see hash to one
// of those 18 folders (tools/_probe_workspace_reach.ts). So the risk is structural
// but not currently reachable. That is exactly the case where a guard is cheap and a
// deletion is expensive.
//
// WHAT THE GUARD IS
// -----------------
// A `workspace.json` marker in the workspace directory recording the schema version
// and the source root it was built from. Rules:
//   * a workspace WITHOUT a marker is 'unknown'  -> never delete
//   * a workspace with a KNOWN OLD version      -> safe to rebuild, reported as such
//   * a workspace claiming a NEWER version      -> never touch (we are the old code)
//
// The marker is the mechanical criterion F19 asked for: "带我们的标记才归我们删".
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CURRENT_MOD_SOURCE_SCHEMA_VERSION,
  classifyModSourceWorkspace,
  writeModSourceWorkspaceMarker,
} from '../../src/utils/mod-source';

let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

function main(): void {
  const root = mkdtempSync(join(tmpdir(), 'modsource-f19-'));

  // ── 1. a directory with no marker is UNKNOWN, never deletable ──────────
  {
    const ws = join(root, 'no-marker');
    mkdirSync(ws, { recursive: true });
    const c = classifyModSourceWorkspace(ws);
    assert('no marker -> unknown', c.kind === 'unknown', c);
    assert('unknown is not deletable', c.deletable === false, c);
  }

  // ── 2. our marker at the current version is rebuildable ────────────────
  {
    const ws = join(root, 'current');
    mkdirSync(ws, { recursive: true });
    writeModSourceWorkspaceMarker(ws, { sourceRoot: 'G:\\some\\mod' });
    const c = classifyModSourceWorkspace(ws);
    assert('current marker -> current', c.kind === 'current', c);
    assert('current is deletable (ours, right version)', c.deletable === true, c);
  }

  // ── 3. an OLD version is reported as stale-old, and deletable ──────────
  // This is the 18-folder case: it IS ours, just written by older code. It may be
  // rebuilt, but only because we can now prove it is ours.
  {
    const ws = join(root, 'old');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'workspace.json'),
      JSON.stringify({ schemaVersion: CURRENT_MOD_SOURCE_SCHEMA_VERSION - 1, sourceRoot: 'x' }),
      'utf8',
    );
    const c = classifyModSourceWorkspace(ws);
    assert('older marker -> stale-old', c.kind === 'stale-old', c);
    assert('stale-old is deletable', c.deletable === true, c);
  }

  // ── 4. a FUTURE version must not be touched ───────────────────────────
  // If a newer build wrote this workspace, this code cannot know its shape, so
  // deleting it would be the exact mistake F19 warns about.
  {
    const ws = join(root, 'future');
    mkdirSync(ws, { recursive: true });
    writeFileSync(
      join(ws, 'workspace.json'),
      JSON.stringify({ schemaVersion: CURRENT_MOD_SOURCE_SCHEMA_VERSION + 1, sourceRoot: 'x' }),
      'utf8',
    );
    const c = classifyModSourceWorkspace(ws);
    assert('future marker -> stale-new', c.kind === 'stale-new', c);
    assert('stale-new is NOT deletable', c.deletable === false, c);
  }

  // ── 5. a corrupt marker must not be read as permission ────────────────
  {
    const ws = join(root, 'corrupt');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'workspace.json'), '{not json', 'utf8');
    const c = classifyModSourceWorkspace(ws);
    assert('corrupt marker -> unknown', c.kind === 'unknown', c);
    assert('corrupt marker is NOT deletable', c.deletable === false, c);
  }

  // ── 6. a directory that does not exist ────────────────────────────────
  {
    const c = classifyModSourceWorkspace(join(root, 'does-not-exist'));
    assert('missing dir -> unknown', c.kind === 'unknown', c);
    assert('missing dir is NOT deletable', c.deletable === false, c);
  }

  // ── 7. ★ the whole point: the guard must be usable on the REAL caches ──
  //
  // A guard that only works on synthetic fixtures proves nothing about the 18 real
  // 3-column caches on this machine. So this section reads the actual dist directory
  // and asserts the classification is decisive for every entry: each one is either
  // deletable or explicitly not, and NONE of them is silently deletable without a
  // marker.
  //
  // Note what this asserts about the real data BEFORE any marker exists: all 18 old
  // caches classify as 'unknown' and therefore as NOT deletable. That is the safe
  // answer, and it will change to 'stale-old' only after a marker is written. The
  // test states both, so a future "let us just clean the cache" cannot pass.
  {
    const realRoot = join(process.cwd(), 'dist', 'mod-sources');
    if (existsSync(realRoot)) {
      const dirs = readdirSync(realRoot, { withFileTypes: true }).filter(d => d.isDirectory());
      let unknown = 0;
      let deletable = 0;
      let undeletable = 0;
      let unmarkedButDeletable = 0;
      for (const d of dirs) {
        const c = classifyModSourceWorkspace(join(realRoot, d.name));
        if (c.kind === 'unknown') unknown += 1;
        if (c.deletable) deletable += 1;
        else undeletable += 1;
        // THE ACTUAL CONTRACT: it is not "nothing is deletable", it is
        // "nothing is deletable WITHOUT a marker proving it is ours".
        //
        // The first version asserted `deletable === 0`, which was true while no
        // workspace carried a marker. The moment resolveModSourceWorkspace started
        // writing markers, two workspaces legitimately became deletable and the
        // assertion failed — not because the guard broke, but because the assertion
        // had encoded a snapshot of today's data instead of the rule.
        //
        // A test that fails when the system starts working is testing the wrong thing.
        if (c.kind === 'unknown' && c.deletable) unmarkedButDeletable += 1;
        assert(
          `real workspace ${d.name} has a decisive class`,
          c.kind === 'current' || c.kind === 'stale-old' || c.kind === 'stale-new' || c.kind === 'unknown',
          c,
        );
        assert(
          `real workspace ${d.name}: unmarked implies protected`,
          !(c.kind === 'unknown' && c.deletable),
          c,
        );
      }
      console.log(
        `  (real: ${dirs.length} workspaces, ${unknown} unmarked, ` +
          `${deletable} deletable, ${undeletable} protected)`,
      );
      assert(
        'no unmarked real workspace is deletable',
        unmarkedButDeletable === 0,
        `${unmarkedButDeletable} of ${unknown} unmarked workspaces were deletable — ` +
          'the guard is not protecting them',
      );
      // And the complementary fact: anything deletable must be marked as ours.
      assert(
        'every deletable workspace is marked',
        dirs.every(d => {
          const c = classifyModSourceWorkspace(join(realRoot, d.name));
          return !c.deletable || c.kind === 'current' || c.kind === 'stale-old';
        }),
        'a workspace is deletable without being classified as current/stale-old',
      );
    } else {
      console.log('  (no dist/mod-sources on this machine; real-data assertions skipped)');
    }
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold a handle briefly; scaffolding noise
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('all assertions passed');
}

main();
