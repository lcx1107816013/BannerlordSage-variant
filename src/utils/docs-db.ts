// src/utils/docs-db.ts
// Shared helpers for the bannerlord_docs_* SQLite schema used by all docs
// sources (own knowledge base, official moddocs, community wiki).
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'

export type DocRow = {
  id: string
  source: string
  language: string
  category: string
  title: string
  url: string
  content: string
  indexedAt: string
}

export function ensureDocsSchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_docs_sources (
      source TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      baseUrl TEXT NOT NULL,
      language TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS bannerlord_docs_pages (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      content TEXT NOT NULL,
      indexedAt TEXT NOT NULL
    );
  `)
  db.run(`
    CREATE VIRTUAL TABLE IF NOT EXISTS bannerlord_docs_fts USING fts5(
      id UNINDEXED,
      source UNINDEXED,
      language UNINDEXED,
      category,
      title,
      url UNINDEXED,
      content,
      tokenize = 'unicode61',
      prefix = '2 3 4'
    );
  `)
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_docs_pages_source_idx ON bannerlord_docs_pages(source);')
  db.run('CREATE INDEX IF NOT EXISTS bannerlord_docs_pages_category_idx ON bannerlord_docs_pages(category);')
}

export function upsertSource(
  db: Database,
  source: string,
  label: string,
  baseUrl: string,
  language: string,
  indexedAt: string
): void {
  db.prepare(`
    INSERT INTO bannerlord_docs_sources (source, label, baseUrl, language, indexedAt)
    VALUES ($source, $label, $baseUrl, $language, $indexedAt)
    ON CONFLICT(source) DO UPDATE SET
      label = excluded.label,
      baseUrl = excluded.baseUrl,
      language = excluded.language,
      indexedAt = excluded.indexedAt
  `).run({
    $source: source,
    $label: label,
    $baseUrl: baseUrl,
    $language: language,
    $indexedAt: indexedAt,
  })
}

export function makeDocId(source: string, url: string): string {
  return createHash('sha1').update(`${source}|${url}`).digest('hex')
}

export function insertDocRows(db: Database, rows: DocRow[]): void {
  const insertPage = db.prepare(`
    INSERT OR REPLACE INTO bannerlord_docs_pages (
      id, source, language, category, title, url, content, indexedAt
    ) VALUES (
      $id, $source, $language, $category, $title, $url, $content, $indexedAt
    )
  `)
  const insertFts = db.prepare(`
    INSERT INTO bannerlord_docs_fts (
      id, source, language, category, title, url, content
    ) VALUES (
      $id, $source, $language, $category, $title, $url, $content
    )
  `)
  const transaction = db.transaction((batch: DocRow[]) => {
    for (const row of batch) {
      insertPage.run({
        $id: row.id,
        $source: row.source,
        $language: row.language,
        $category: row.category,
        $title: row.title,
        $url: row.url,
        $content: row.content,
        $indexedAt: row.indexedAt,
      })
      insertFts.run({
        $id: row.id,
        $source: row.source,
        $language: row.language,
        $category: row.category,
        $title: row.title,
        $url: row.url,
        $content: row.content,
      })
    }
  })
  transaction(rows)
}

export function deleteDocsBySource(db: Database, source: string): void {
  db.prepare('DELETE FROM bannerlord_docs_pages WHERE source = $source').run({ $source: source })
  db.prepare('DELETE FROM bannerlord_docs_fts WHERE source = $source').run({ $source: source })
  db.prepare('DELETE FROM bannerlord_docs_sources WHERE source = $source').run({ $source: source })
}
