// Clean mod-source workspaces THAT CAN BE PROVEN TO BE OURS.
//
// WHY THIS TOOL EXISTS AT ALL
// ---------------------------
// F19 asked for a mechanical criterion before any cleanup, because
// `dist/mod-sources/*` is a directory of things that look identical: a current
// cache, an old cache, an empty leftover, and (in principle) a cache written by a
// newer build. Only the marker distinguishes them, and "it is in a cache folder so
// it must be a cache" is exactly the reasoning that deletes data.
//
// This tool therefore has NO mode that deletes an unmarked workspace. `--dry-run` is
// the default; `--apply` still refuses anything classifyModSourceWorkspace does not
// explicitly mark deletable, and it reports every refusal with its reason.
//
// Measured on this machine (2026-10-18): 214 workspaces, ALL unmarked, 18 of which
// hold a 3-column csharp_files with 3 rows each. Running this tool today reports them
// as protected and deletes nothing. That is the correct outcome, not a bug: the point
// is that the decision is now made by evidence instead of by directory listing.
//
// Usage:
//   bun run tools/clean-mod-sources.ts               # report only (default)
//   bun run tools/clean-mod-sources.ts --apply       # delete only provably-ours caches
//   bun run tools/clean-mod-sources.ts --keep-empty  # also keep empty unmarked dirs
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { classifyModSourceWorkspace } from '../src/utils/mod-source';
import { distPath } from '../src/utils/env';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const keepEmpty = args.includes('--keep-empty');

const root = join(distPath, 'mod-sources');
if (!existsSync(root)) {
  console.error(`no such directory: ${root}`);
  process.exit(2);
}

type Row = {
  id: string;
  kind: string;
  deletable: boolean;
  reason: string;
  empty: boolean;
  bytes: number;
};

const rows: Row[] = [];
for (const entry of readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const ws = join(root, entry.name);
  const cls = classifyModSourceWorkspace(ws);

  // "empty" here means the workspace has no files at all -- the 180 leftovers. It is
  // still not deletable without a marker, because an empty directory can be a
  // workspace whose index step failed midway, and deleting it would hide that.
  let bytes = 0;
  let files = 0;
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else {
        files += 1;
        try {
          bytes += statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(ws);

  rows.push({
    id: entry.name,
    kind: cls.kind,
    deletable: cls.deletable,
    reason: cls.reason,
    empty: files === 0,
    bytes,
  });
}

const byKind: Record<string, Row[]> = {};
for (const r of rows) (byKind[r.kind] ??= []).push(r);

console.log(`mod-source workspaces: ${rows.length}  (${root})`);
console.log('');
for (const kind of ['current', 'stale-old', 'stale-new', 'unknown']) {
  const list = byKind[kind] ?? [];
  if (list.length === 0) continue;
  const del = list.filter(r => r.deletable).length;
  const bytes = list.reduce((a, r) => a + r.bytes, 0);
  console.log(
    `  ${kind.padEnd(10)} ${String(list.length).padStart(4)}  ` +
      `deletable ${String(del).padStart(4)}  ${(bytes / 1024 / 1024).toFixed(1)} MB`,
  );
}

const deletable = rows.filter(r => r.deletable && !(keepEmpty && r.empty));
const protectedRows = rows.filter(r => !r.deletable);

console.log('');
console.log(`would delete : ${deletable.length}`);
console.log(`must keep    : ${protectedRows.length}`);
if (protectedRows.length > 0) {
  const reasons = new Set(protectedRows.map(r => r.reason));
  console.log('  reasons:');
  for (const reason of reasons) console.log(`    - ${reason}`);
}

if (!apply) {
  console.log('');
  console.log('dry run. Re-run with --apply to delete the provably-ours ones.');
  process.exit(0);
}

let removed = 0;
let failed = 0;
for (const r of deletable) {
  try {
    rmSync(join(root, r.id), { recursive: true, force: true });
    removed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  failed ${r.id}: ${(err as Error).message}`);
  }
}
console.log('');
console.log(`deleted ${removed}, failed ${failed}, kept ${protectedRows.length}`);
process.exit(failed > 0 ? 1 : 0);
