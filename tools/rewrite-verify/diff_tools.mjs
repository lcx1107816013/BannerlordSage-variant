// Direct baseline-vs-rewrite differential for the tool-layer files in batch 3:
//   list-directory.ts, read-file.ts         (also covered by gen_tools_fixtures.mjs)
//   mod-source-status.ts, read-mod-type.ts, list-mod-directory.ts,
//   read-mod-file.ts, search-mod-source.ts, index-mod-source.ts
//
// The six mod-source wrappers have an INHERITED witness only: gen_modsourceindex_fixtures.mjs
// exercises the facade (utils/local-mod-csharp-index.ts) and search-mod-source.ts, but never
// list_mod_directory / read_mod_file / index_mod_source / mod_source_status / read_mod_type
// through their own module entry points. So this runner supplies the missing witness by
// comparing each rewrite against baseline 8311c9a's version of the same file.
//
// ★ THE INDEXER IS MOCKED, DELIBERATELY. ensureLocalModSourceIndex runs the Roslyn indexer
//   (dotnet build + run), which is unavailable here and additionally throws from an
//   undefined `$indexedAt` in src/scripts/index-csharp.ts. Left alone, EVERY case would
//   throw on BOTH sides and compare equal — a vacuous pass. The injected summary points at
//   a workspace this runner builds itself (see mod-workspace.mjs), so the facade and the
//   wrappers both execute REAL code over REAL files while dotnet stays out of the picture.
//   The harness prints a caveat whenever a case still throws on both sides, so a regression
//   to that state is visible rather than silent.
//
// Usage: bun run tools/rewrite-verify/diff_tools.mjs

import { join } from 'node:path'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { mock } from 'bun:test'
import { repoRoot, cleanupShadow, report, loadBoth, diffCases } from './diffharness.mjs'
import { buildModWorkspace } from './mod-workspace.mjs'

// ★ Scratch corpora live under tools/rewrite-verify/.tmp, NOT under server-go/, so this
//   harness never writes inside the golden generator's tree.
const PARITY = join(repoRoot, 'tools', 'rewrite-verify', '.tmp')

// A private paging corpus, built here rather than borrowed, so read-file/read-mod-file see
// the awkward window shapes (negative start, huge count, past-the-end start).
const pageRoot = join(PARITY, 'pageroot')
rmSync(pageRoot, { recursive: true, force: true })
mkdirSync(join(pageRoot, 'sub'), { recursive: true })
writeFileSync(join(pageRoot, 'plain.txt'), 'l0\nl1\nl2\nl3\nl4', 'utf8')
writeFileSync(join(pageRoot, 'trailing.txt'), 'a\nb\n', 'utf8')
writeFileSync(join(pageRoot, 'empty.txt'), '', 'utf8')
writeFileSync(join(pageRoot, 'sub', 'nested.txt'), 'n0\nn1\nn2', 'utf8')

// ── the private mod workspace, and the injected summary that points at it ────
const workspace = await buildModWorkspace()
const INJECTED_SUMMARY = {
  workspace: {
    workspaceRoot: workspace.workspaceRoot,
    sourceRoot: workspace.sourceRoot,
    cacheRoot: workspace.cacheRoot,
    workspaceId: workspace.workspaceId,
    workspacePath: workspace.cacheRoot,
    // ★ dbPath lives ON the workspace object: readLocalModType opens
    //   workspace.dbPath, and omitting it here is what made every read throw
    //   "Cannot open an anonymous database in read-only mode".
    dbPath: workspace.dbPath,
  },
  csharpFileCount: 3,
  filesScanned: 3,
  changedFiles: 2,
  removedFiles: 1,
  typeCount: 4,
  memberCount: 7,
  sourceLocalizationCount: 5,
  sourceDir: workspace.sourceRoot,
  workspaceId: workspace.workspaceId,
  dbPath: workspace.dbPath,
}
{
  const indexerPath = join(repoRoot, 'src', 'scripts', 'index-mod-source.ts')
  for (const key of [indexerPath, indexerPath.replaceAll('\\', '/')]) {
    mock.module(key, () => ({ buildModSourceIndex: async () => INJECTED_SUMMARY }))
  }
}

cleanupShadow()
let allOk = true
let total = 0

// ── 1. list-directory.ts, over a real tree ──────────────────────────────────
{
  const { PathSandbox } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'path-sandbox.ts')).href)
  const cases = [
    { label: 'root', rel: '' },
    { label: 'subdir', rel: 'sub' },
    { label: 'missing', rel: 'no-such-dir', expectThrow: true },
    { label: 'file-not-dir', rel: 'plain.txt', expectThrow: true },
    { label: 'escape', rel: '../escape', expectThrow: true },
  ]
  const { baselineMod, liveMod } = await loadBoth('src/tools/list-directory.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.listDirectory,
    liveMod.listDirectory,
    cases,
    (fn, c) => fn(new PathSandbox(pageRoot), c.rel)
  )
  total += cases.length
  allOk = report('src/tools/list-directory.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

// ── 2. read-file.ts, over the same tree, with the awkward windows ───────────
{
  const { PathSandbox } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'path-sandbox.ts')).href)
  const { clearTextFileCache } = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'text-file-cache.ts')).href)

  const cases = [
    { label: 'default', rel: 'plain.txt', start: 0, count: 400 },
    { label: 'window', rel: 'plain.txt', start: 1, count: 2 },
    { label: 'negative-start', rel: 'plain.txt', start: -5, count: 2 },
    { label: 'negative-both', rel: 'plain.txt', start: -5, count: -5 },
    { label: 'past-end', rel: 'plain.txt', start: 99, count: 5 },
    { label: 'huge', rel: 'plain.txt', start: 2, count: 1000000 },
    { label: 'empty-file', rel: 'empty.txt', start: 0, count: 10 },
    { label: 'trailing-newline', rel: 'trailing.txt', start: 0, count: 10 },
    { label: 'nested', rel: 'sub/nested.txt', start: 0, count: 2 },
    { label: 'missing', rel: 'nope.txt', start: 0, count: 2, expectThrow: true },
    { label: 'escape', rel: '../escape.txt', start: 0, count: 2, expectThrow: true },
  ]
  const { baselineMod, liveMod } = await loadBoth('src/tools/read-file.ts')
  // The slice cache is cleared before each side so neither inherits the other's entry.
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(baselineMod.readFile, liveMod.readFile, cases, async (fn, c) => {
    clearTextFileCache()
    return await fn(new PathSandbox(pageRoot), c.rel, c.start, c.count)
  })
  total += cases.length
  allOk = report('src/tools/read-file.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

// ── 3. the mod-source *file* wrappers, against the private workspace ────────
// ★ The sandbox roots at the workspace's SOURCE root (…/modws/src), not at the
//   workspace root, so every case path below is relative to that. 'Logic' is the
//   second real success case; the rest pin the failure text.
const MOD_CASES = [
  { label: 'source-root', rel: '' },
  { label: 'nested-dir', rel: 'Logic' },
  { label: 'file-not-dir', rel: 'SubModule.cs', expectThrow: true },
  { label: 'missing', rel: 'nope.cs', expectThrow: true },
  { label: 'escape', rel: '../../escape', expectThrow: true },
]

{
  const { baselineMod, liveMod } = await loadBoth('src/tools/list-mod-directory.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.listModDirectory,
    liveMod.listModDirectory,
    MOD_CASES,
    (fn, c) => fn(workspace.workspaceRoot, c.rel)
  )
  total += MOD_CASES.length
  allOk = report('src/tools/list-mod-directory.ts', problems, MOD_CASES.length, unexpectedThrows, expectedThrows) && allOk
}

{
  const cases = [
    { label: 'whole', rel: 'SubModule.cs', start: 0, count: 400 },
    { label: 'window', rel: 'SubModule.cs', start: 1, count: 1 },
    { label: 'negative', rel: 'SubModule.cs', start: -3, count: 2 },
    { label: 'past-end', rel: 'SubModule.cs', start: 99, count: 3 },
    { label: 'nested', rel: 'Logic/PartyLogic.cs', start: 0, count: 400 },
    { label: 'missing', rel: 'nope.cs', start: 0, count: 2, expectThrow: true },
    { label: 'escape', rel: '../escape.cs', start: 0, count: 2, expectThrow: true },
  ]
  const { baselineMod, liveMod } = await loadBoth('src/tools/read-mod-file.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.readModFile,
    liveMod.readModFile,
    cases,
    (fn, c) => fn(workspace.workspaceRoot, c.rel, c.start, c.count)
  )
  total += cases.length
  allOk = report('src/tools/read-mod-file.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

{
  const cases = [
    { label: 'hit', q: 'SubModule', cs: false, pat: undefined },
    { label: 'case-sensitive-miss', q: 'submodule', cs: true, pat: undefined },
    { label: 'no-hit', q: 'NOT_IN_CORPUS', cs: false, pat: undefined },
    { label: 'pattern-cs', q: 'Run', cs: false, pat: '*.cs' },
    { label: 'pattern-nomatch', q: 'SubModule', cs: false, pat: '*.xml' },
  ]
  const { baselineMod, liveMod } = await loadBoth('src/tools/search-mod-source.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.searchModSource,
    liveMod.searchModSource,
    cases,
    (fn, c) => fn(workspace.workspaceRoot, c.q, c.cs, c.pat)
  )
  total += cases.length
  allOk = report('src/tools/search-mod-source.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

// ── 4. the two delegations the injected summary makes observable ────────────
{
  const cases = [{ label: 'injected-summary', root: workspace.workspaceRoot }]
  const { baselineMod, liveMod } = await loadBoth('src/tools/index-mod-source.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.indexModSource,
    liveMod.indexModSource,
    cases,
    (fn, c) => fn(c.root)
  )
  total += cases.length
  allOk = report('src/tools/index-mod-source.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

{
  const cases = [{ label: 'injected-summary', root: workspace.workspaceRoot }]
  const { baselineMod, liveMod } = await loadBoth('src/tools/mod-source-status.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.modSourceStatus,
    liveMod.modSourceStatus,
    cases,
    (fn, c) => fn(c.root)
  )
  total += cases.length
  allOk = report('src/tools/mod-source-status.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

// ── 5. read-mod-type.ts. The injected summary points at the database built by
//      mod-workspace.mjs, so the reads are real. The corpus is chosen for the
//      rules this reader owns: a name colliding across two files (the
//      disambiguation report), a unique name, a row whose .cs file is ABSENT
//      (the silent-skip rule), and a name that is not indexed at all (the
//      facade's notFoundText, which interpolates the source root). ───────────
{
  const cases = ['SubModule', 'PartyLogic', 'GhostType', 'NotThere', ''].map(t => ({
    label: JSON.stringify(t),
    typeName: t,
  }))
  const { baselineMod, liveMod } = await loadBoth('src/tools/read-mod-type.ts')
  const { problems, expectedThrows, unexpectedThrows } = await diffCases(
    baselineMod.readModType,
    liveMod.readModType,
    cases,
    (fn, c) => fn(workspace.workspaceRoot, c.typeName)
  )
  total += cases.length
  allOk = report('src/tools/read-mod-type.ts', problems, cases.length, unexpectedThrows, expectedThrows) && allOk
}

cleanupShadow()
console.log(allOk ? `ALL EQUAL — ${total} differential cases` : 'DIVERGENCE FOUND')
process.exit(allOk ? 0 : 1)
