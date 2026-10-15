// Package store manages SQLite connections, porting src/utils/db.ts and
// src/utils/memory-db.ts.
//
// Parity notes:
//   - bannerlord.db is opened writable with busy_timeout=5000 and no WAL
//     (same as the TS runtime path).
//   - bannerlord-memory.db is opened writable, no WAL, busy_timeout=5000,
//     and the schema is created on first open.
package store

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

var (
	mainDB   *sql.DB
	mainPath string
	memDB    *sql.DB
	memPath  string
)

// OpenDB opens (or returns the cached singleton for) the main game index
// database, mirroring getDb() in src/utils/db.ts.
func OpenDB(path string) (*sql.DB, error) {
	if mainDB != nil && mainPath == path {
		return mainDB, nil
	}
	if mainDB != nil {
		_ = mainDB.Close()
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	mainDB = db
	mainPath = path
	return mainDB, nil
}

// OpenMemoryDB opens (or returns the cached singleton for) the project memory
// database, mirroring getMemoryDb() in src/utils/memory-db.ts: it creates the
// parent directory and ensures the schema on first open.
func OpenMemoryDB(path string) (*sql.DB, error) {
	if memDB != nil && memPath == path {
		return memDB, nil
	}
	if memDB != nil {
		_ = memDB.Close()
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 5000"); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := ensureMemorySchema(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	memDB = db
	memPath = path
	return memDB, nil
}

// CloseAll mirrors closeDb() + closeMemoryDb() for graceful shutdown.
func CloseAll() {
	if mainDB != nil {
		_ = mainDB.Close()
		mainDB = nil
	}
	if memDB != nil {
		_ = memDB.Close()
		memDB = nil
	}
}

// HasTable mirrors databaseHasTable(): a short-lived readonly probe of
// sqlite_master. Errors are swallowed and reported as false, like the TS version.
//
// ★ The predicate is `type = 'table'`, matching the TypeScript exactly. The previous
// version used `type IN ('table','view')`, which also answered true for a VIEW — a
// divergence the differential fixtures now catch. A caller asking "is this table
// present" must not be told yes because a view of the same name exists.
func HasTable(path, table string) bool {
	db, err := openReadonly(path)
	if err != nil {
		return false
	}
	defer db.Close()
	row := db.QueryRow(
		`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`,
		table)
	var count int
	if err := row.Scan(&count); err != nil {
		return false
	}
	return count > 0
}

// openReadonly opens a short-lived read-only connection. Both the TypeScript and this
// port use one connection per probe and close it immediately, so a failure to open is
// the caller's "false"/"0"/"undefined" rather than an error.
func openReadonly(path string) (*sql.DB, error) {
	return sql.Open("sqlite", path+"?mode=ro")
}

// HasColumns mirrors databaseHasColumns(): every expected column must be present.
//
// Note the semantics: it is "all of these exist", NOT "these and only these exist".
// Reading it as an equality check would reject tables that legitimately carry extra
// columns.
func HasColumns(path, table string, expected []string) bool {
	db, err := openReadonly(path)
	if err != nil {
		return false
	}
	defer db.Close()

	// PRAGMA cannot be parameterised, so the identifier is quoted instead. The quoting
	// is the same function the TypeScript uses, which is what makes the two comparable
	// for hostile table names.
	rows, err := db.Query(`PRAGMA table_info(` + quoteIdentifier(table) + `)`)
	if err != nil {
		return false
	}
	defer rows.Close()

	available := make(map[string]struct{})
	columns, err := rows.Columns()
	if err != nil {
		return false
	}
	for rows.Next() {
		// table_info returns: cid, name, type, notnull, dflt_value, pk
		values := make([]any, len(columns))
		for i := range values {
			values[i] = new(any)
		}
		if err := rows.Scan(values...); err != nil {
			return false
		}
		nameIndex := -1
		for i, c := range columns {
			if c == "name" {
				nameIndex = i
				break
			}
		}
		if nameIndex < 0 {
			return false
		}
		if name, ok := (*(values[nameIndex].(*any))).(string); ok {
			available[name] = struct{}{}
		}
	}
	if err := rows.Err(); err != nil {
		return false
	}

	for _, want := range expected {
		if _, ok := available[want]; !ok {
			return false
		}
	}
	return true
}

// TableRowCount mirrors databaseTableRowCount().
func TableRowCount(path, table string) int {
	db, err := openReadonly(path)
	if err != nil {
		return 0
	}
	defer db.Close()
	row := db.QueryRow(`SELECT COUNT(*) AS count FROM ` + quoteIdentifier(table))
	var count int
	if err := row.Scan(&count); err != nil {
		return 0
	}
	return count
}

// TableRowCountWhereEquals mirrors databaseTableRowCountWhereEquals().
//
// The value is bound as a parameter, matching the TypeScript's $value binding. Only the
// IDENTIFIERS are interpolated (quoted), which is the same split the TypeScript makes.
func TableRowCountWhereEquals(path, table, column, value string) int {
	db, err := openReadonly(path)
	if err != nil {
		return 0
	}
	defer db.Close()
	row := db.QueryRow(
		`SELECT COUNT(*) AS count FROM `+quoteIdentifier(table)+
			` WHERE `+quoteIdentifier(column)+` = ?`, value)
	var count int
	if err := row.Scan(&count); err != nil {
		return 0
	}
	return count
}

// TextValue mirrors databaseTextValue() with LIMIT 1.
//
// Returns (value, true) only when the stored value is a TEXT value, matching the
// TypeScript's `typeof row?.value === 'string'` check. A numeric or NULL column yields
// (_, false), which the caller reads as "undefined" — the distinction matters because a
// caller doing string work on a number would otherwise get a coerced result.
func TextValue(path, table, keyColumn, keyValue, valueColumn string) (string, bool) {
	db, err := openReadonly(path)
	if err != nil {
		return "", false
	}
	defer db.Close()
	row := db.QueryRow(
		`SELECT `+quoteIdentifier(valueColumn)+` AS value FROM `+quoteIdentifier(table)+
			` WHERE `+quoteIdentifier(keyColumn)+` = ? LIMIT 1`, keyValue)

	// Scan into any so the type can be inspected rather than coerced: scanning into a
	// string would happily turn an integer column into its decimal text and report
	// success where the TypeScript reports undefined.
	var raw any
	if err := row.Scan(&raw); err != nil {
		return "", false
	}
	text, isString := raw.(string)
	if !isString {
		return "", false
	}
	return text, true
}

// quoteIdentifier mirrors escapeSqlIdentifier(): wrap in double quotes and double any
// embedded quote. Same transformation, so hostile identifiers behave identically.
func quoteIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

// ensureMemorySchema mirrors memory-db.ts lines 38-79 (identical DDL).
func ensureMemorySchema(db *sql.DB) error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS project_memories (
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
			invalidated_at TEXT)`,
		`CREATE INDEX IF NOT EXISTS idx_project_memories_workspace ON project_memories(workspace, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_project_memories_topic ON project_memories(topic, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_project_memories_kind ON project_memories(kind, updated_at DESC)`,
		`CREATE INDEX IF NOT EXISTS idx_project_memories_status ON project_memories(status, updated_at DESC)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS project_memories_fts USING fts5(
			public_id UNINDEXED, workspace, topic, kind, summary, text, tags_text,
			tokenize = 'unicode61')`,
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("ensureMemorySchema: %w", err)
		}
	}
	return nil
}
