// Runtime index database access (bun:sqlite).
//
// One cached connection per process, keyed by database path: switching
// games closes the previous handle. The connection also drops itself when
// the index revision changes (runtime-revision hook) so a re-index is
// picked up without restarting the server. The inspection helpers open
// short-lived read-only handles so they can probe arbitrary databases
// (parity checks, doctor) without touching the runtime connection.
import { Database } from 'bun:sqlite'
import { getGamePaths } from './env'
import { ensureRuntimeRevisionFresh, registerRuntimeInvalidator } from './runtime-revision'

let _runtimeDb: Database | null = null
let _runtimeDbPath: string | null = null

export function getDb(gameId?: string): Database {
  ensureRuntimeRevisionFresh(gameId)
  const resolvedDbPath = getGamePaths(gameId).dbPath

  if (_runtimeDb !== null && _runtimeDbPath !== resolvedDbPath) {
    closeDb()
  }

  if (_runtimeDb === null) {
    _runtimeDb = new Database(resolvedDbPath)
    _runtimeDbPath = resolvedDbPath
    _runtimeDb.run('PRAGMA busy_timeout = 5000;')
  }

  return _runtimeDb
}

export function closeDb(): void {
  const open = _runtimeDb
  _runtimeDb = null
  _runtimeDbPath = null
  open?.close()
}

registerRuntimeInvalidator(() => {
  closeDb()
})

/**
 * Opens `path` read-only for the duration of one probe and closes it again,
 * reporting `fallback` whenever the database cannot be opened or the query
 * fails. Every inspection helper below is this shape, so the open/close
 * pairing exists once instead of five times.
 */
function withReadOnlyDb<T>(path: string, fallback: T, probe: (db: Database) => T): T {
  const db = new Database(path, { create: false, readonly: true })
  try {
    return probe(db)
  } catch {
    return fallback
  } finally {
    db.close()
  }
}

export function databaseHasTable(path: string, tableName: string): boolean {
  return withReadOnlyDb(path, false, db => {
    const row = db
      .query<{ name: string }, { $tableName: string }>(
        `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = $tableName
      `
      )
      .get({ $tableName: tableName })

    return Boolean(row)
  })
}

export function databaseHasColumns(path: string, tableName: string, expectedColumns: string[]): boolean {
  return withReadOnlyDb(path, false, db => {
    const rows = db
      .query<{ name: string }, never>(
        `
        PRAGMA table_info(${quoteSqlIdentifier(tableName)})
      `
      )
      .all()

    const available = new Set(rows.map(row => row.name))
    return expectedColumns.every(column => available.has(column))
  })
}

export function databaseTableRowCount(path: string, tableName: string): number {
  return withReadOnlyDb(path, 0, db => {
    const row = db
      .query<{ count: number }, never>(
        `
        SELECT COUNT(*) AS count
        FROM ${quoteSqlIdentifier(tableName)}
      `
      )
      .get()

    return Number(row?.count ?? 0)
  })
}

export function databaseTableRowCountWhereEquals(
  path: string,
  tableName: string,
  columnName: string,
  value: string
): number {
  return withReadOnlyDb(path, 0, db => {
    const row = db
      .query<{ count: number }, { $value: string }>(
        `
        SELECT COUNT(*) AS count
        FROM ${quoteSqlIdentifier(tableName)}
        WHERE ${quoteSqlIdentifier(columnName)} = $value
      `
      )
      .get({ $value: value })

    return Number(row?.count ?? 0)
  })
}

export function databaseTextValue(
  path: string,
  tableName: string,
  keyColumnName: string,
  keyValue: string,
  valueColumnName: string
): string | undefined {
  return withReadOnlyDb(path, undefined as string | undefined, db => {
    const row = db
      .query<{ value: string }, { $keyValue: string }>(
        `
        SELECT ${quoteSqlIdentifier(valueColumnName)} AS value
        FROM ${quoteSqlIdentifier(tableName)}
        WHERE ${quoteSqlIdentifier(keyColumnName)} = $keyValue
        LIMIT 1
      `
      )
      .get({ $keyValue: keyValue })

    return typeof row?.value === 'string' ? row.value : undefined
  })
}

// Identifiers (table/column names) cannot be bound as parameters, so they
// are quoted manually; values always go through bound parameters.
function quoteSqlIdentifier(rawIdentifier: string): string {
  const escaped = rawIdentifier.replaceAll('"', '""')
  return `"${escaped}"`
}
