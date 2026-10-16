// Restores the LOCAL precondition that gen_modsourceindex_fixtures.mjs assumes.
//
// WHY THIS IS NEEDED
// ------------------
// That generator DELETEs from csharp_types / csharp_methods / csharp_files and only THEN
// CREATEs them. Its `CREATE TABLE IF NOT EXISTS` therefore only ever sees an existing table,
// so the DELETE only works when the three tables are already present. The workspace
// database lives under dist/mod-sources/<id>/, which .gitignore excludes entirely (the
// `*.db` negation covers only server-go/tools/parity/fixtures/*.db), so the file is LOCAL
// STATE that builds up over time and is absent on a fresh clone. On such a clone the
// generator fails at its first DELETE with "no such table: csharp_types".
//
// ★ This is a PRE-EXISTING latent fragility, not a consequence of the rewrite. The rewrite
//   only deleted the polluted local cache directory, which removed local state the generator
//   had been silently depending on. The generator itself is out of scope and is left alone:
//   server-go/ is the golden generator and must not be edited by this task.
//
// This script recreates the three tables in the shape the generator expects — copied from
// the generator's own DDL, which in turn was copied from the real index. The generator's
// own DELETE + INSERT then proceeds normally.
//
// Usage: bun run tools/rewrite-verify/restore-modsource-fixture-db.mjs

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './diffharness.mjs'

// The workspace id the generator resolves for its corpus: 12 hex of sha1 over the
// case-folded, slash-normalized source root. Derived through the REAL resolver so this
// cannot drift if the hashing rule changes.
const modSource = await import(pathToFileURL(join(repoRoot, 'src', 'utils', 'mod-source.ts')).href)
const corpusRoot = join(repoRoot, 'server-go', 'tools', 'parity', 'fixtures', 'modsource-workspace')
const workspace = await modSource.resolveModSourceWorkspace(corpusRoot)

mkdirSync(workspace.cacheRoot, { recursive: true })
const db = new Database(workspace.dbPath, { create: true })

const existing = db
  .query(`SELECT name FROM sqlite_master WHERE type='table'`)
  .all()
  .map(row => row.name)

// DDL copied verbatim from gen_modsourceindex_fixtures.mjs so the shape matches exactly.
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

const after = db
  .query(`SELECT name FROM sqlite_master WHERE type='table'`)
  .all()
  .map(row => row.name)
db.close()

console.log(`workspace db: ${workspace.dbPath}`)
console.log(`tables before: ${existing.length === 0 ? '(none)' : existing.join(', ')}`)
console.log(`tables after : ${after.join(', ')}`)
console.log('gen_modsourceindex_fixtures.mjs can now run its DELETE step.')

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-17 UPDATE: the generator this script works around has been FIXED.
//
// `gen_modsourceindex_fixtures.mjs` used to DELETE from the three tables BEFORE its
// `CREATE TABLE IF NOT EXISTS` statements, which made it depend on the tables already
// existing. Since the workspace database lives under dist/mod-sources/ (excluded by
// .gitignore wholesale, so absent on a fresh clone), the generator died on its first
// DELETE anywhere the corpus had not already been created once.
//
// The generator now emits DDL first and clears the tables afterwards. Verified by
// deleting dist/mod-sources entirely and re-running: exit 0, 9 cases, byte-identical to
// the frozen golden copy, and idempotent across two consecutive runs.
//
// This script is KEPT as a fallback for the case it still covers: a workspace whose
// database exists but is in an unknown state (for example left behind by an interrupted
// run). It is no longer required for a fresh clone.
