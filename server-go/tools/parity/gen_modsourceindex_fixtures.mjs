// Parity fixture generator for the local mod C# index facade:
//   src/utils/local-mod-csharp-index.ts -> tools.ModSourceStatus / tools.ReadModType
//   src/tools/search-mod-source.ts      -> tools.SearchModSource
//
// The TS facade's status/read functions call ensureLocalModSourceIndex first, which
// RUNS THE ROSLYN INDEXER (dotnet build + run). That is a .NET pipeline this port does
// not reproduce, so the harness injects the indexer's script module and hands the facade
// a prebuilt workspace database — the same module-injection technique as
// gen_searchapidocs_fixtures.mjs, keeping the functions under test REAL.
//
// The corpus separates rules:
//   * a workspace with an `src` subdir (sourceRoot != workspaceRoot) — the summary must
//     report BOTH, and the type read's topFields carry both
//   * two types whose NAMES collide across files — the multi-match disambiguation
//     report, which is CsharpTypeOptions' whole reason to exist
//   * a type whose file is MISSING from the workspace — the silent-skip rule pinned by
//     the reader's own parity suite, observed through the local-mod vocabulary here
//   * a type not in the index at all — the facade's own notFoundText, which INTERPOLATES
//     the source root ('was not found in the indexed mod source workspace (<root>)')
//   * an EMPTY workspace (no .cs files) — status still renders, with count 0
//
// Usage: bun run server-go/tools/parity/gen_modsourceindex_fixtures.mjs

import { Database } from 'bun:sqlite'
import { mock } from 'bun:test'
import { writeFileSync, mkdirSync, writeFileSync as wf, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, '..', '..', '..')
const NL = String.fromCharCode(10)

// ── the workspace corpus ─────────────────────────────────────────────────────
const corpusRoot = join(here, 'fixtures', 'modsource-workspace')
if (existsSync(corpusRoot)) rmSync(corpusRoot, { recursive: true, force: true })

// Workspace WITH an src/ layout: sourceRoot points at src, workspaceRoot at the parent.
const srcRoot = join(corpusRoot, 'src')
mkdirSync(srcRoot, { recursive: true })
wf(join(srcRoot, 'SubModule.cs'), 'namespace MyMod {\n  public class SubModule { }\n}\n')
wf(join(srcRoot, 'Helpers.cs'), 'namespace MyMod {\n  internal class SubModule { }\n}\n')
wf(join(srcRoot, 'PartyLogic.cs'), 'namespace MyMod.Logic {\n  public class PartyLogic {\n    public void Run() { }\n  }\n}\n')
// GhostType.cs is deliberately NOT written: its csharp_types row exists but the file is
// absent, exercising the reader's silent-skip rule through the facade.

const emptyRoot = join(here, 'fixtures', 'modsource-empty')
if (existsSync(emptyRoot)) rmSync(emptyRoot, { recursive: true, force: true })
mkdirSync(emptyRoot, { recursive: true })

// ── the prebuilt workspace database ──────────────────────────────────────────
// The workspace id is sha1(lowercased forward-slashed sourceRoot)[:12]; the TS computes
// it through getModSourcePaths, which we drive through the REAL mod-source module with
// BANNERSAGE_GAME redirected? No — distPath is repo dist/, same as the real one. We let
// the real resolver run and create the cache dir; then we write the database THERE.
const envMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'env.ts')).href)
const modSourceMod = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'mod-source.ts')).href)
const { resolveModSourceWorkspace } = modSourceMod

// Redirect the repo root so the cache lands beside the fixtures instead of dist/: the
// env module's distPath is derived from ITS OWN file location, so it already points at
// the real repo. That is fine — mod-sources/<id> under the real dist is a cache path no
// other test uses, and it keeps the resolver REAL. The guard: refuse a non-fresh id.
const workspace = await resolveModSourceWorkspace(corpusRoot)
console.log('workspace cache at:', workspace.dbPath)

const db = new Database(workspace.dbPath)
// ★ IDEMPOTENCY, AND WHY THE DDL COMES FIRST.
//
// This generator ran before and the workspace database SURVIVES between runs
// (resolveModSourceWorkspace creates but never clears it), so plain INSERTs double the
// rows on every regeneration — measured: 8 csharp_types rows after two runs, while the
// fixture text still said 3 from the first. The reader's disambiguation then rendered
// five matches where two belonged.
//
// The first fix DELETEd before CREATE, which was wrong in the other direction: it made
// the generator depend on the tables already existing. On a fresh clone there is no
// database at all — the path lives under dist/mod-sources/, which .gitignore excludes
// wholesale — so the run died on the first DELETE and the generator could only ever work
// on the machine that had already run it once. DDL first, NULL-safety second:
db.run(`CREATE TABLE IF NOT EXISTS csharp_types (
  typeName TEXT, fullName TEXT, namespaceName TEXT, containingType TEXT,
  filePath TEXT, startLine INTEGER, endLine INTEGER, typeKind TEXT,
  accessibility TEXT, modifiers TEXT
)`)
db.run(`CREATE TABLE IF NOT EXISTS csharp_methods (
  id TEXT PRIMARY KEY, typeFullName TEXT, memberName TEXT, memberKind TEXT,
  signature TEXT, returnType TEXT, filePath TEXT,
  startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER
)`)
db.run(`CREATE TABLE IF NOT EXISTS csharp_files (
  filePath TEXT PRIMARY KEY, fileSize INTEGER, fileMtimeMs REAL
)`)
// Now that every table is guaranteed to exist, clear them so a regeneration cannot
// accumulate rows. This is the half that makes the corpus identical on every run.
db.run(`DELETE FROM csharp_types`)
db.run(`DELETE FROM csharp_methods`)
db.run(`DELETE FROM csharp_files`)
const insertType = db.prepare(`INSERT INTO csharp_types (typeName, fullName, namespaceName, containingType, filePath, startLine, endLine, typeKind, accessibility, modifiers) VALUES (?,?,?,?,?,?,?,?,?,?)`)
insertType.run('SubModule', 'MyMod.SubModule', 'MyMod', null, 'SubModule.cs', 2, 4, 'class', 'public', '')
insertType.run('SubModule', 'MyMod.SubModule#inner', 'MyMod', 'SubModule', 'Helpers.cs', 2, 4, 'class', 'internal', '')
insertType.run('PartyLogic', 'MyMod.Logic.PartyLogic', 'MyMod.Logic', null, 'PartyLogic.cs', 2, 5, 'class', 'public', '')
insertType.run('GhostType', 'MyMod.GhostType', 'MyMod', null, 'GhostType.cs', 1, 3, 'class', 'public', '')
const insertMethod = db.prepare(`INSERT INTO csharp_methods (id, typeFullName, memberName, memberKind, signature, returnType, filePath, startLine, endLine, accessibility, isStatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
insertMethod.run('p1', 'MyMod.Logic.PartyLogic', 'Run', 'method', 'public void Run()', 'void', 'PartyLogic.cs', 3, 4, 'public', 0)
db.run(`INSERT INTO csharp_files VALUES ('SubModule.cs', 60, 1000.0)`)
db.run(`INSERT INTO csharp_files VALUES ('Helpers.cs', 61, 1000.0)`)
db.run(`INSERT INTO csharp_files VALUES ('PartyLogic.cs', 100, 1000.0)`)
db.close()

// ── inject the indexer so the facade reads instead of builds ─────────────────
// ★ The injected indexer derives its counts FROM THE DATABASE it would have written —
//   the real buildModSourceIndex returns table counts (countRows(db, 'csharp_types') etc.
//   in index-mod-source.ts), so a hand-written '3' here would pin a number the port can
//   never reproduce. The first run of this generator did exactly that and the
//   differential caught it: TS said 3 (hardcoded), Go said 4 (counted, including
//   GhostType). Deriving both sides from the same table is the honest contract.
const indexerReal = join(repoRoot, 'src', 'scripts', 'index-mod-source.ts')
mock.module(indexerReal, () => ({
  buildModSourceIndex: async (sourceDir) => {
    const ws = await resolveModSourceWorkspace(sourceDir)
    const count = await modSourceMod.countModSourceCSharpFiles(ws.sourceRoot)
    // The EMPTY workspace has no database (the real indexer would create one); the
    // probe degrades to 0 counts rather than failing to open a file that is not there.
    let typeCount = 0
    let memberCount = 0
    try {
      const probe = new Database(ws.dbPath, { readonly: true })
      typeCount = probe.query(`SELECT COUNT(*) AS c FROM csharp_types`).get().c
      memberCount = probe.query(`SELECT COUNT(*) AS c FROM csharp_methods`).get().c
      probe.close()
    } catch {}
    return {
      workspace: ws,
      csharpFileCount: count,
      filesScanned: 0,
      changedFiles: 0,
      removedFiles: 0,
      typeCount,
      memberCount,
      sourceLocalizationCount: 0,
      sourceDir: ws.sourceRoot,
      workspaceId: ws.workspaceId,
      dbPath: ws.dbPath,
    }
  },
}))

const facade = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'local-mod-csharp-index.ts')).href)
const { getLocalModSourceStatus, readLocalModType } = facade

const cases = []

// status: the src-layout workspace
{
  const res = await getLocalModSourceStatus(corpusRoot)
  cases.push({ kind: 'status', workspaceRoot: corpusRoot, ok: true, text: res.content[0].text })
}
// status: an empty workspace — no .cs files at all
{
  const res = await getLocalModSourceStatus(emptyRoot)
  cases.push({ kind: 'status', workspaceRoot: emptyRoot, ok: true, text: res.content[0].text })
}
// read: a name that collides across two files -> disambiguation
{
  const res = await readLocalModType(corpusRoot, 'SubModule')
  cases.push({ kind: 'read', workspaceRoot: corpusRoot, typeName: 'SubModule', ok: true, text: res.content[0].text })
}
// read: unique type
{
  const res = await readLocalModType(corpusRoot, 'PartyLogic')
  cases.push({ kind: 'read', workspaceRoot: corpusRoot, typeName: 'PartyLogic', ok: true, text: res.content[0].text })
}
// read: row exists but file missing -> silently skipped
{
  const res = await readLocalModType(corpusRoot, 'GhostType')
  cases.push({ kind: 'read', workspaceRoot: corpusRoot, typeName: 'GhostType', ok: true, text: res.content[0].text })
}
// read: absent type -> the facade's notFoundText with the interpolated root
{
  const res = await readLocalModType(corpusRoot, 'NotThere')
  cases.push({ kind: 'read', workspaceRoot: corpusRoot, typeName: 'NotThere', ok: true, text: res.content[0].text })
}

// search_mod_source: the three-line wrapper over searchSource
const searchMod = await import(pathToFileURL(join(repoRoot, 'src', 'tools', 'search-mod-source.ts')).href)
const { searchModSource } = searchMod
for (const q of [
  { query: 'SubModule', caseSensitive: false },
  { query: 'submodule', caseSensitive: true },
  { query: 'NOT_IN_CORPUS', caseSensitive: false },
]) {
  const res = await searchModSource(corpusRoot, q.query, q.caseSensitive, undefined)
  cases.push({ kind: 'search', workspaceRoot: corpusRoot, ...q, ok: true, text: res.content[0].text })
}

// ── record ───────────────────────────────────────────────────────────────────
// The corpus paths must be stripped so the Go side can rebuild the tree elsewhere.
const stripCorpus = value => typeof value === 'string' ? value.split(corpusRoot).join('<CORPUS>') : value
const stripped = cases.map(c => ({ ...c, workspaceRoot: stripCorpus(c.workspaceRoot), text: stripCorpus(c.text) }))

const fixtures = {
  _comment:
    'GENERATED by gen_modsourceindex_fixtures.mjs. Expected values come from EXECUTING the real ' +
    'src/utils/local-mod-csharp-index.ts and src/tools/search-mod-source.ts with the indexer script ' +
    'injected via mock.module, against the corpus in fixtures/modsource-workspace and the prebuilt ' +
    'workspace database under <repo>/dist/mod-sources/<id>/mod-source.db. Paths are stripped to ' +
    '<CORPUS> so the Go side can rebuild elsewhere. Do not edit by hand.',
  corpusFiles: ['src/SubModule.cs', 'src/Helpers.cs', 'src/PartyLogic.cs'],
  cases: stripped,
}
writeFileSync(join(here, 'modsourceindex_fixtures.json'), JSON.stringify(fixtures, null, 2) + NL, 'utf8')

console.log('wrote modsourceindex_fixtures.json')
console.log('  cases: ' + cases.length)
