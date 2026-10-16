// Builds a private, self-contained mod-source workspace for the batch-3 differential.
//
// WHY NOT REUSE THE COMMITTED FIXTURE CORPUS
// -------------------------------------------
// gen_modsourceindex_fixtures.mjs leaves its corpus under server-go/tools/parity/fixtures/,
// and its persisted workspace database can be empty at the moment this runner executes (the
// generator deletes the csharp_* rows and re-inserts inside its own run). Pointing
// read_mod_type at it produced five cases that all threw on both sides — a vacuous pass,
// which the harness now reports as such.
//
// So this module builds its own tree and its own database, with the same DDL the fixture
// generator copies from the real index. That makes every case observable:
//   * src/SubModule.cs and src/Helpers.cs both declare `SubModule` -> disambiguation
//   * src/Logic/PartyLogic.cs declares a unique type                -> single match
//   * a csharp_types row whose .cs file is ABSENT (GhostType)       -> silent skip
//   * a nested directory                                            -> a real dir listing
//
// ★ THE PATHS COME FROM THE REAL RESOLVER, not from arithmetic here. resolveModSourceWorkspace
//   decides the source root, the cache directory and the database file name, so the tree this
//   module writes is exactly the tree the facade will look in. Hand-computing the workspace id
//   was tried and WAS WRONG: the hash is taken over the resolved source root, and a
//   hand-derived value pointed readLocalModType at a path that did not exist, which surfaced
//   as "Cannot open an anonymous database in read-only mode".

import { Database } from 'bun:sqlite'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './diffharness.mjs'

export const WORKSPACE_ROOT = join(repoRoot, 'tools', 'rewrite-verify', '.tmp', 'modws')

export async function buildModWorkspace() {
  rmSync(WORKSPACE_ROOT, { recursive: true, force: true })

  const srcRoot = join(WORKSPACE_ROOT, 'src')
  mkdirSync(join(srcRoot, 'Logic'), { recursive: true })
  writeFileSync(join(srcRoot, 'SubModule.cs'), 'namespace MyMod {\n  public class SubModule { }\n}\n', 'utf8')
  writeFileSync(join(srcRoot, 'Helpers.cs'), 'namespace MyMod {\n  internal class SubModule { }\n}\n', 'utf8')
  writeFileSync(
    join(srcRoot, 'Logic', 'PartyLogic.cs'),
    'namespace MyMod.Logic {\n  public class PartyLogic {\n    public void Run() { }\n  }\n}\n',
    'utf8'
  )
  // GhostType.cs is deliberately NOT written: its csharp_types row exists, so the reader's
  // silent-skip rule is exercised through the wrapper.

  // The real resolver decides every path, including which file the database lives in.
  const modSource = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'mod-source.ts')).href)
  const workspace = await modSource.resolveModSourceWorkspace(WORKSPACE_ROOT)

  mkdirSync(workspace.cacheRoot, { recursive: true })
  rmSync(workspace.dbPath, { force: true })

  const db = new Database(workspace.dbPath, { create: true })
  db.run(`CREATE TABLE csharp_types (
    typeName TEXT, fullName TEXT, namespaceName TEXT, containingType TEXT,
    filePath TEXT, startLine INTEGER, endLine INTEGER, typeKind TEXT,
    accessibility TEXT, modifiers TEXT
  )`)
  db.run(`CREATE TABLE csharp_methods (
    id TEXT PRIMARY KEY, typeFullName TEXT, memberName TEXT, memberKind TEXT,
    signature TEXT, returnType TEXT, filePath TEXT,
    startLine INTEGER, endLine INTEGER, accessibility TEXT, isStatic INTEGER
  )`)
  db.run(`CREATE TABLE csharp_files (
    filePath TEXT PRIMARY KEY, fileSize INTEGER, fileMtimeMs REAL
  )`)

  const insertType = db.prepare(
    `INSERT INTO csharp_types (typeName, fullName, namespaceName, containingType, filePath, startLine, endLine, typeKind, accessibility, modifiers) VALUES (?,?,?,?,?,?,?,?,?,?)`
  )
  insertType.run('SubModule', 'MyMod.SubModule', 'MyMod', null, 'SubModule.cs', 2, 4, 'class', 'public', '')
  insertType.run('SubModule', 'MyMod.SubModule#inner', 'MyMod', 'SubModule', 'Helpers.cs', 2, 4, 'class', 'internal', '')
  insertType.run('PartyLogic', 'MyMod.Logic.PartyLogic', 'MyMod.Logic', null, 'Logic/PartyLogic.cs', 2, 5, 'class', 'public', '')
  insertType.run('GhostType', 'MyMod.GhostType', 'MyMod', null, 'GhostType.cs', 1, 3, 'class', 'public', '')

  const insertMethod = db.prepare(
    `INSERT INTO csharp_methods (id, typeFullName, memberName, memberKind, signature, returnType, filePath, startLine, endLine, accessibility, isStatic) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  )
  insertMethod.run('p1', 'MyMod.Logic.PartyLogic', 'Run', 'method', 'public void Run()', 'void', 'Logic/PartyLogic.cs', 3, 4, 'public', 0)

  db.run(`INSERT INTO csharp_files VALUES ('SubModule.cs', 60, 1000.0)`)
  db.run(`INSERT INTO csharp_files VALUES ('Helpers.cs', 61, 1000.0)`)
  db.run(`INSERT INTO csharp_files VALUES ('Logic/PartyLogic.cs', 100, 1000.0)`)
  db.close()

  return {
    workspaceRoot: WORKSPACE_ROOT,
    sourceRoot: workspace.sourceRoot,
    cacheRoot: workspace.cacheRoot,
    dbPath: workspace.dbPath,
    workspaceId: workspace.workspaceId,
  }
}
