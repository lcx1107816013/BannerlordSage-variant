// Package docsdb ports src/utils/docs-db.ts: the shared schema and write path for the
// `bannerlord_docs_*` tables that every docs source (own knowledge base, official moddocs,
// community wiki) is indexed into, and that search_docs reads.
//
// ★ THE SCHEMA IS PART OF THE CONTRACT, not an implementation detail. The FTS table's column ORDER
// is what the bm25 weights in search_docs are positional against, and `prefix = '2 3 4'` is what
// makes the `"token"*` queries the shared query builder produces cheap. A port that "tidied" either
// would change ranking rather than fail loudly.
package docsdb

import (
	"crypto/sha1"
	"database/sql"
	"encoding/hex"
)

// DocRow mirrors DocRow.
type DocRow struct {
	ID        string
	Source    string
	Language  string
	Category  string
	Title     string
	URL       string
	Content   string
	IndexedAt string
}

// EnsureSchema mirrors ensureDocsSchema.
//
// ★ EVERY STATEMENT IS `IF NOT EXISTS`, so it is safe to run against an existing index and is
// therefore called before every write path rather than once at startup. The two secondary indexes
// are on the BASE table, not the FTS table — an FTS5 table cannot take one.
//
// ★ `prefix = '2 3 4'` IS A PERFORMANCE CHOICE, NOT A CORRECTNESS ONE — measured, because the
// opposite is easy to assume. A `"token"*` prefix query returns the same rows with and without the
// option (1 in a two-row probe); what the option buys is an index FTS5 can use for 2-, 3- and
// 4-character prefixes, so dropping it would leave every search CORRECT but slower on the term
// shapes the shared query builder produces. It is preserved because the schema is part of the
// contract search results are recorded against, and the distinction is recorded so nobody later
// "simplifies" it away believing it changes results.
func EnsureSchema(db *sql.DB) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS bannerlord_docs_sources (
      source TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      language TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );`,
		`CREATE TABLE IF NOT EXISTS bannerlord_docs_pages (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      content TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS bannerlord_docs_fts USING fts5(
      id UNINDEXED,
      source UNINDEXED,
      language UNINDEXED,
      category,
      title,
      url UNINDEXED,
      content,
      tokenize = 'unicode61',
      prefix = '2 3 4'
    );`,
		`CREATE INDEX IF NOT EXISTS bannerlord_docs_pages_source_idx ON bannerlord_docs_pages(source);`,
		`CREATE INDEX IF NOT EXISTS bannerlord_docs_pages_category_idx ON bannerlord_docs_pages(category);`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

// UpsertSource mirrors upsertSource: an insert that replaces the four mutable fields on conflict.
//
// ★ THE CONFLICT TARGET IS `source` ALONE. bannerlord_docs_sources has `source` as its PRIMARY KEY,
// so the upsert is keyed by the source id; the label, base URL, language and timestamp are all
// overwritten. A re-index therefore updates the row in place, and a caller reading the row cannot
// tell whether it was inserted or updated.
func UpsertSource(db *sql.DB, source, label, baseURL, language, indexedAt string) error {
	_, err := db.Exec(`
    INSERT INTO bannerlord_docs_sources (source, label, baseUrl, language, indexedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source) DO UPDATE SET
      label = excluded.label,
      baseUrl = excluded.baseUrl,
      language = excluded.language,
      indexedAt = excluded.indexedAt
  `, source, label, baseURL, language, indexedAt)
	return err
}

// MakeDocID mirrors makeDocId: the SHA-1 of `source|url`, lowercase hex — 40 characters.
//
// ★ THE SEPARATOR IS PART OF THE INPUT, so the id is not simply "the hash of the url". Two sources
// indexing the SAME url therefore get different ids, which is what lets one page appear under both
// without a primary-key collision. A port that hashed only the url would silently collapse them.
//
// The TypeScript uses createHash('sha1'); Go's crypto/sha1 produces the same bytes, and
// hex.EncodeToString produces the same lowercase hex that digest('hex') does.
func MakeDocID(source, url string) string {
	sum := sha1.Sum([]byte(source + "|" + url))
	return hex.EncodeToString(sum[:])
}

// InsertDocRows mirrors insertDocRows: two inserts per row, in ONE transaction.
//
// ★ THE TRANSACTION IS THE POINT. The base table and the FTS table are written separately, so a
// failure between them would leave the index searchable-but-unrecoverable: a reader would find the
// row's text in FTS while the pages table had no record of where it came from. batching them in one
// transaction is what makes "indexed" a single state.
//
// ★ THE FTS INSERT IS A PLAIN INSERT, NOT `INSERT OR REPLACE`, while the page is a replace. So
// re-indexing the same url REPLACES the page row and APPENDS a second FTS row — measured: five rows
// inserted twice leave five pages and TEN fts rows. That looks like a defect and it is the
// original's behaviour; the docs indexers delete by source before re-inserting (see
// DeleteDocsBySource), which is what keeps the two in step.
//
// ★ AND THE ASYMMETRY IS INVISIBLE TO THE DATABASE, WHICH IS WHY IT IS WRITTEN DOWN HERE. A
// standalone FTS5 table has NO unique constraint — sqlite_master shows only its five shadow tables
// and no index on the virtual table itself — so `INSERT` and `INSERT OR REPLACE` behave IDENTICALLY:
// two inserts of the same id leave two rows either way (measured). Making the two statements match
// therefore changes nothing today and would change everything the day someone adds a unique index,
// so the original's spelling is kept and the measurement is recorded next to it.
func InsertDocRows(db *sql.DB, rows []DocRow) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	insertPage, err := tx.Prepare(`
    INSERT OR REPLACE INTO bannerlord_docs_pages (
      id, source, language, category, title, url, content, indexedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
	if err != nil {
		return err
	}
	defer insertPage.Close()

	insertFts, err := tx.Prepare(`
    INSERT INTO bannerlord_docs_fts (
      id, source, language, category, title, url, content
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)
	if err != nil {
		return err
	}
	defer insertFts.Close()

	for _, row := range rows {
		if _, err := insertPage.Exec(row.ID, row.Source, row.Language, row.Category, row.Title,
			row.URL, row.Content, row.IndexedAt); err != nil {
			return err
		}
		if _, err := insertFts.Exec(row.ID, row.Source, row.Language, row.Category, row.Title,
			row.URL, row.Content); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// DeleteDocsBySource mirrors deleteDocsBySource: three statements, no transaction.
//
// ★ NO TRANSACTION HERE, UNLIKE THE INSERT PATH, and the asymmetry is the original's. It matters
// for the same reason: a failure after the pages delete but before the FTS delete would leave
// searchable text whose page row is gone. The port keeps the shape so the differential compares the
// same thing; a caller that needs atomicity has to supply it.
func DeleteDocsBySource(db *sql.DB, source string) error {
	for _, statement := range []string{
		`DELETE FROM bannerlord_docs_pages WHERE source = ?`,
		`DELETE FROM bannerlord_docs_fts WHERE source = ?`,
		`DELETE FROM bannerlord_docs_sources WHERE source = ?`,
	} {
		if _, err := db.Exec(statement, source); err != nil {
			return err
		}
	}
	return nil
}
