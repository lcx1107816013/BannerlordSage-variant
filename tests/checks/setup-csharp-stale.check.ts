/**
 * Regression test for setup's "should the C# index be rebuilt?" decision.
 *
 * WHY THIS EXISTS
 * ---------------
 * `--dll-scope core -> official` decompiled 167 DLLs (16230 .cs files on disk),
 * but setup printed
 *
 *     Skipping SQLite rebuild because the indexed inputs are unchanged.
 *
 * and the index stayed at 5203 types / 4099 files. A forced rebuild then produced
 * 19188 types / 16230 files — a 3.7x difference that was invisible for a whole
 * build.
 *
 * THE DEFECT: the condition was
 *
 *     shouldBuildCsharpIndex = !skipDecompile && (clean || decompiledDlls > 0 || !hasCsharpIndex)
 *
 * and `hasCsharpIndex` only asked whether the TABLES EXIST. On a second run the
 * DLLs are skipped (so `decompiledDlls === 0`), the tables exist, and the answer is
 * "unchanged" — even though the Source tree had just gained 12131 files that the
 * index had never seen.
 *
 * That is the project's signature failure once more: the check could see "a table
 * exists" but not "the table covers what is on disk", and the two read the same.
 *
 * WHAT THE FIX MUST DO
 * --------------------
 * The decision has to compare the index against the DISK, not against its own past
 * existence. `csharpMustRebuild` below is that comparison, exported so it can be
 * tested without running a decompile or touching the real database.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { csharpIndexIsStale } from '../../src/scripts/setup';

let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

function makeDb(dbPath: string, files: { path: string; size: number }[]): void {
  const db = new Database(dbPath, { create: true });
  try {
    db.run(`CREATE TABLE csharp_files (
      filePath TEXT PRIMARY KEY, fileSize INTEGER NOT NULL, fileMtimeMs INTEGER NOT NULL,
      indexedAt TEXT NOT NULL)`);
    const insert = db.prepare(
      'INSERT INTO csharp_files (filePath, fileSize, fileMtimeMs, indexedAt) VALUES (?, ?, ?, ?)',
    );
    for (const f of files) {
      insert.run(f.path, f.size, 1, new Date().toISOString());
    }
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'setup-stale-'));

  // ── A. index covers exactly what is on disk -> NOT stale ────────────────
  {
    const dir = join(root, 'a');
    const source = join(dir, 'Source');
    const dbPath = join(dir, 'probe.db');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'bin', 'A.cs'), 'namespace A { class A {} }', 'utf8');
    makeDb(dbPath, [{ path: 'bin/A.cs', size: 26 }]);

    const stale = await csharpIndexIsStale({ sourcePath: source, dbPath });
    assert('index matching the disk is not stale', stale.stale === false, stale);
  }

  // ── B. disk has files the index never saw -> STALE ─────────────────────
  // This is the exact shape that was skipped: the index exists, so the old check
  // said "fine", while the Source tree had grown by whole directories.
  {
    const dir = join(root, 'b');
    const source = join(dir, 'Source');
    const dbPath = join(dir, 'probe.db');
    mkdirSync(join(source, 'bin'), { recursive: true });
    mkdirSync(join(source, 'Modules', 'BirthAndDeath', 'bin'), { recursive: true });
    writeFileSync(join(source, 'bin', 'A.cs'), 'namespace A { class A {} }', 'utf8');
    writeFileSync(
      join(source, 'Modules', 'BirthAndDeath', 'bin', 'B.cs'),
      'namespace B { class B {} }',
      'utf8',
    );
    makeDb(dbPath, [{ path: 'bin/A.cs', size: 26 }]);

    const stale = await csharpIndexIsStale({ sourcePath: source, dbPath });
    assert('index missing a whole new directory is stale', stale.stale === true, stale);
    assert(
      'the staleness reason counts the uncovered files',
      typeof stale.unindexed === 'number' && stale.unindexed >= 1,
      stale,
    );
  }

  // ── C. a file changed size -> STALE ───────────────────────────────────
  {
    const dir = join(root, 'c');
    const source = join(dir, 'Source');
    const dbPath = join(dir, 'probe.db');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'bin', 'A.cs'), 'namespace A { class A { int x; } }', 'utf8');
    makeDb(dbPath, [{ path: 'bin/A.cs', size: 1 }]); // recorded a different size

    const stale = await csharpIndexIsStale({ sourcePath: source, dbPath });
    assert('a changed file makes the index stale', stale.stale === true, stale);
  }

  // ── D. no index at all -> STALE (must build) ──────────────────────────
  {
    const dir = join(root, 'd');
    mkdirSync(join(dir, 'Source'), { recursive: true });
    const stale = await csharpIndexIsStale({
      sourcePath: join(dir, 'Source'),
      dbPath: join(dir, 'missing.db'),
    });
    assert('a missing index is stale', stale.stale === true, stale);
  }

  // ── E. index has files the disk no longer has -> STALE ────────────────
  {
    const dir = join(root, 'e');
    const source = join(dir, 'Source');
    const dbPath = join(dir, 'probe.db');
    mkdirSync(join(source, 'bin'), { recursive: true });
    writeFileSync(join(source, 'bin', 'A.cs'), 'namespace A { class A {} }', 'utf8');
    makeDb(dbPath, [
      { path: 'bin/A.cs', size: 26 },
      { path: 'bin/Gone.cs', size: 26 },
    ]);

    const stale = await csharpIndexIsStale({ sourcePath: source, dbPath });
    assert('a removed source file makes the index stale', stale.stale === true, stale);
  }

  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold the WAL sidecar briefly; scaffolding noise, not a failure
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('all assertions passed');
}

main().catch(error => {
  console.error('setup-csharp-stale check crashed:', error);
  process.exit(1);
});
