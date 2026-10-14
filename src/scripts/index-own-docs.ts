// src/scripts/index-own-docs.ts
// Build the own-knowledge FTS index from the in-repo knowledge/ tree plus any
// extra directories configured via BANNERSAGE_OWN_DOCS_DIRS. This is the
// default knowledge source; external web docs are opt-in via index:docs.
import { Database } from 'bun:sqlite'
import { ensureSetupDirectoriesForGame } from '../utils/bannerlord-setup'
import {
  deleteDocsBySource,
  ensureDocsSchema,
  insertDocRows,
  upsertSource,
} from '../utils/docs-db'
import { getGamePaths } from '../utils/env'
import {
  buildOwnDocRows,
  listOwnDocDirs,
  listOwnDocFiles,
  OWN_DOCS_SOURCE,
} from '../utils/own-docs'

export function buildOwnDocsIndex(gameId?: string): { files: number; rows: number } {
  const { dbPath, gameId: resolvedGameId } = getGamePaths(gameId)
  ensureSetupDirectoriesForGame(resolvedGameId)

  const dirs = listOwnDocDirs()
  const files = listOwnDocFiles(dirs)
  const indexedAt = new Date().toISOString()
  const rows = buildOwnDocRows(files, indexedAt)

  const db = new Database(dbPath)
  db.run('PRAGMA busy_timeout = 5000;')
  db.run('PRAGMA journal_mode = WAL;')

  try {
    ensureDocsSchema(db)
    deleteDocsBySource(db, OWN_DOCS_SOURCE.id)
    upsertSource(
      db,
      OWN_DOCS_SOURCE.id,
      OWN_DOCS_SOURCE.label,
      OWN_DOCS_SOURCE.baseUrl,
      OWN_DOCS_SOURCE.language,
      indexedAt
    )
    insertDocRows(db, rows)
  } finally {
    db.close()
  }

  console.log(`Own knowledge index built for ${resolvedGameId}.`)
  console.log(`Dirs: ${dirs.join(', ')}`)
  console.log(`Markdown files: ${files.length}`)
  console.log(`Indexed sections: ${rows.length}`)
  return { files: files.length, rows: rows.length }
}

if (import.meta.main) {
  try {
    buildOwnDocsIndex()
  } catch (error) {
    console.error(`Fatal error while building the own-knowledge index: ${error instanceof Error ? error.stack || error.message : String(error)}`)
    process.exit(1)
  }
}
