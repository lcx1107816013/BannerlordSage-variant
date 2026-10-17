/**
 * Regression tests for the C# AST index — specifically the incremental path.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `setup --dll-scope official` died at its LAST step with
 *
 *     ReferenceError: $indexedAt is not defined
 *        at index-csharp.ts:483
 *
 * The line was `upsertTrackedFile.run({ ..., $indexedAt })` — object shorthand
 * reading a variable named `$indexedAt`, which does not exist (the variable is
 * `indexedAt`). A reference error in a loop that never runs is invisible.
 *
 * TWO THINGS MADE IT SURVIVE:
 *   1. The loop is `for (const file of changedFiles)`. On an already-built index
 *      with no source changes, `changedFiles` is empty and the body never executes.
 *   2. No test executed `buildCsharpIndexForWorkspace` at all. Every existing check
 *      covered assets, mod conflicts or the Bridge client — nothing covered indexing.
 *
 * So the bug could only appear on the one occasion that changes every file at once,
 * which is exactly a scope widening. It appeared the first time that happened.
 *
 * WHAT THESE TESTS PIN (each names a rule that could plausibly be wrong again):
 *   - a FIRST build (changedFiles = all files) completes and records indexedAt.
 *   - a SECOND build with an unchanged tree takes the skip path and reports 0 scanned.
 *   - a build with ONE changed file completes — this is the incremental path that
 *     exercises the loop body without a full rebuild.
 *   - `csharp_files.indexedAt` is a parseable ISO timestamp, not NULL and not the
 *     string "undefined" — the two shapes a broken parameter binding produces.
 *   - a deleted source file is removed from the index (stalePaths path).
 *
 * The Roslyn indexer is not run: these tests drive `applyPayload` through the
 * public entry point with a pre-seeded dump, because the reference error was in the
 * SQLite write, not in Roslyn. A test that needed the .NET toolchain would skip on
 * most machines and therefore would not be a regression test.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildCsharpIndexForWorkspace } from '../../src/scripts/index-csharp';

let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

/** A minimal payload the indexer would have produced for one type. */
function payloadFor(): string {
  return JSON.stringify({
    types: [
      {
        typeName: 'Probe',
        fullName: 'Probe.ProbeType',
        namespaceName: 'Probe',
        filePath: 'Probe.cs',
        startLine: 1,
        endLine: 10,
        typeKind: 'class',
        members: [],
        literals: [],
      },
    ],
    literals: [],
    sourceLocalizations: [],
  });
}

async function build(root: string) {
  const sourcePath = join(root, 'Source');
  const dbPath = join(root, 'probe.db');
  const dumpPath = join(root, 'dump.json');
  mkdirSync(sourcePath, { recursive: true });
  writeFileSync(dumpPath, payloadFor(), 'utf8');
  return buildCsharpIndexForWorkspace({
    sourcePath,
    dbPath,
    csharpAstDumpPath: dumpPath,
  } as Parameters<typeof buildCsharpIndexForWorkspace>[0]);
}

function readIndexedAt(dbPath: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query('SELECT filePath, indexedAt FROM csharp_files').all() as {
      filePath: string;
      indexedAt: string | null;
    }[];
    return rows.map(row => String(row.indexedAt));
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'csharp-index-'));

  // ── 1. first build: every file is "changed", so the loop body runs ──────
  const sourcePath = join(root, 'Source');
  mkdirSync(sourcePath, { recursive: true });
  writeFileSync(join(sourcePath, 'Probe.cs'), 'namespace Probe { public class ProbeType {} }\n', 'utf8');

  const first = await build(root);
  assert('first build scans the file', first.filesScanned === 1, first);
  assert('first build reports the change', first.changedFiles === 1, first);

  const stamps = readIndexedAt(join(root, 'probe.db'));
  assert('indexedAt is recorded for the tracked file', stamps.length === 1, stamps);
  assert(
    'indexedAt is a real ISO timestamp (not null, not "undefined")',
    stamps.length === 1 &&
      stamps[0] !== 'undefined' &&
      !Number.isNaN(Date.parse(stamps[0])),
    stamps,
  );

  // ── 2. second build, unchanged: the skip path ──────────────────────────
  const second = await build(root);
  assert('unchanged rebuild skips scanning', second.filesScanned === 0, second);
  assert('unchanged rebuild reports zero changes', second.changedFiles === 0, second);

  // ── 3. one changed file: incremental, loop body runs without a full scan ──
  // This is the shape that used to throw: a non-empty `changedFiles` reaching the
  // upsert with a broken parameter binding.
  writeFileSync(
    join(sourcePath, 'Probe.cs'),
    'namespace Probe { public class ProbeType { int x; int y; } }\n',
    'utf8',
  );
  const third = await build(root);
  assert('incremental rebuild reports exactly one change', third.changedFiles === 1, third);
  const stampsAfterIncremental = readIndexedAt(join(root, 'probe.db'));
  assert(
    'incremental rebuild still records a valid indexedAt',
    stampsAfterIncremental.length === 1 &&
      stampsAfterIncremental[0] !== 'undefined' &&
      !Number.isNaN(Date.parse(stampsAfterIncremental[0])),
    stampsAfterIncremental,
  );

  // ── 4. deleted file is dropped from the index ─────────────────────────
  rmSync(join(sourcePath, 'Probe.cs'));
  const fourth = await build(root);
  assert('deleting the source reports a removal', fourth.removedFiles === 1, fourth);
  assert('deleted file no longer tracked', readIndexedAt(join(root, 'probe.db')).length === 0);

  // Cleanup is best-effort: on Windows the SQLite WAL sidecar can still be held for
  // a moment after the connection closes, and an EBUSY here says nothing about the
  // indexer. A cleanup failure must not be reported as a test failure, or the real
  // signal gets buried under scaffolding noise.
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // left in the OS temp directory; harmless
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('all assertions passed');
}

main().catch(error => {
  console.error('csharp-index check crashed:', error);
  process.exit(1);
});
