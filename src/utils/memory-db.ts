// Cross-session project memory storage (bun:sqlite).
//
// A small dedicated database next to the main index: one table for memory
// records plus an FTS5 mirror for full-text search. Recreated lazily per
// game; the schema is idempotent so opening an existing database is a no-op.
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { Database } from 'bun:sqlite'
import { getActiveGameId, getGamePaths, normalizeGameId } from './env'

let memoryDb: Database | null = null
let memoryDbPath: string | null = null

/** The database file belonging to `gameId` (defaulting to the active game). */
function resolveMemoryDbPath(gameId?: string): string {
  const resolvedGameId = normalizeGameId(gameId || getActiveGameId())
  return getGamePaths(resolvedGameId).memoryDbPath
}

export function getMemoryDb(gameId?: string): Database {
  const resolvedPath = resolveMemoryDbPath(gameId)
  const pointsElsewhere = memoryDb !== null && memoryDbPath !== resolvedPath

  if (pointsElsewhere) {
    closeMemoryDb()
  }

  if (memoryDb === null) {
    mkdirSync(dirname(resolvedPath), { recursive: true })
    // Handle and path are recorded before the schema runs so a failed
    // migration still leaves a closed handle on the next call, not a leak.
    memoryDb = new Database(resolvedPath)
    memoryDbPath = resolvedPath
    memoryDb.run('PRAGMA busy_timeout = 5000;')
    createMemorySchema(memoryDb)
  }

  return memoryDb
}

export function closeMemoryDb(): void {
  const open = memoryDb
  memoryDb = null
  memoryDbPath = null
  open?.close()
}

function createMemorySchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id TEXT NOT NULL UNIQUE,
      workspace TEXT NOT NULL,
      topic TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT,
      text TEXT NOT NULL,
      source TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]',
      tags_text TEXT NOT NULL DEFAULT '',
      importance INTEGER NOT NULL DEFAULT 3,
      status TEXT NOT NULL DEFAULT 'active',
      invalidation_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      invalidated_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_project_memories_workspace
      ON project_memories (workspace, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_memories_topic
      ON project_memories (topic, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_memories_kind
      ON project_memories (kind, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_project_memories_status
      ON project_memories (status, updated_at DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS project_memories_fts USING fts5(
      public_id UNINDEXED,
      workspace,
      topic,
      kind,
      summary,
      text,
      tags_text,
      tokenize = 'unicode61'
    );
  `)
}
