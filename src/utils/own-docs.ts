// src/utils/own-docs.ts
// Own-knowledge-base source: walks in-repo `knowledge/` markdown (plus any
// extra dirs configured via BANNERSAGE_OWN_DOCS_DIRS) and splits each file
// into FTS-indexable sections. Pure functions; no I/O beyond reading files.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { root } from './env'
import { makeDocId, type DocRow } from './docs-db'

export const OWN_DOCS_SOURCE = {
  id: 'own_knowledge',
  label: 'Own Knowledge Base (in-repo knowledge/ + configured dirs)',
  baseUrl: 'knowledge/',
  language: 'zh-en',
}

export function knowledgeRoot(): string {
  return join(root, 'knowledge')
}

export function listOwnDocDirs(): string[] {
  const dirs = [knowledgeRoot()]
  const extra = process.env.BANNERSAGE_OWN_DOCS_DIRS?.trim()
  if (extra) {
    for (const part of extra.split(/[;|]/)) {
      const trimmed = part.trim()
      if (trimmed) dirs.push(resolve(trimmed))
    }
  }
  return dirs.filter(dir => {
    try {
      return statSync(dir).isDirectory()
    } catch {
      return false
    }
  })
}

export function listOwnDocFiles(dirs: string[] = listOwnDocDirs()): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  for (const dir of dirs) {
    walkMarkdown(dir, dir, files, seen)
  }
  return files.sort()
}

function walkMarkdown(baseDir: string, dir: string, out: string[], seen: Set<string>): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkMarkdown(baseDir, full, out, seen)
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const key = resolve(full).toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        out.push(full)
      }
    }
  }
}

export type MarkdownSection = {
  slug: string
  heading: string
  content: string
}

/** Split markdown into `##` sections; text before the first `##` becomes the intro section. */
export function splitMarkdownIntoSections(markdown: string): MarkdownSection[] {
  const text = stripFrontmatter(markdown).replace(/\r\n/g, '\n')
  const lines = text.split('\n')

  const sections: MarkdownSection[] = []
  let currentHeading = ''
  let currentSlug = 'intro'
  let buffer: string[] = []

  const flush = () => {
    const content = buffer.join('\n').trim()
    if (currentHeading || content) {
      sections.push({ slug: currentSlug, heading: currentHeading, content })
    }
  }

  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) {
      flush()
      currentHeading = match[1]
      currentSlug = slugify(match[1])
      buffer = []
    } else {
      buffer.push(line)
    }
  }
  flush()

  return sections
}

export function stripFrontmatter(markdown: string): string {
  if (!markdown.startsWith('---')) return markdown
  const end = markdown.indexOf('\n---', 3)
  if (end < 0) return markdown
  return markdown.slice(markdown.indexOf('\n', end + 1) + 1)
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
  return slug || 'section'
}

export function titleFromFile(markdown: string, filePath: string): string {
  const text = stripFrontmatter(markdown)
  const h1 = /^#\s+(.+?)\s*$/m.exec(text)
  if (h1) return h1[1].trim()
  return relative(knowledgeRoot(), filePath).replace(/\\/g, '/').replace(/\.md$/i, '')
}

export function buildOwnDocRows(files: string[], indexedAt: string): DocRow[] {
  const rows: DocRow[] = []
  for (const filePath of files) {
    let markdown: string
    try {
      markdown = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const fileTitle = titleFromFile(markdown, filePath)
    const relativePath = relative(knowledgeRoot(), filePath).replace(/\\/g, '/')
    // category = first path segment under knowledge/ (e.g. modding, suite)
    const category = relativePath.includes('/') ? relativePath.split('/')[0] : 'root'

    for (const section of splitMarkdownIntoSections(markdown)) {
      const headingSuffix = section.heading ? ` — ${section.heading}` : ''
      const content = [section.heading, section.content].filter(Boolean).join('\n')
      if (!content) continue
      const url = `knowledge://${relativePath}#${section.slug}`
      rows.push({
        id: makeDocId(OWN_DOCS_SOURCE.id, url),
        source: OWN_DOCS_SOURCE.id,
        language: OWN_DOCS_SOURCE.language,
        category,
        title: `${fileTitle}${headingSuffix}`,
        url,
        content,
        indexedAt,
      })
    }
  }
  return rows
}
