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
// sqlite_master. Errors are swallowed and reported as false, like the TS
// version.
func HasTable(path, table string) bool {
	db, err := sql.Open("sqlite", path+"?mode=ro")
	if err != nil {
		return false
	}
	defer db.Close()
	row := db.QueryRow(
		`SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
		table)
	var count int
	if err := row.Scan(&count); err != nil {
		return false
	}
	return count > 0
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
