// Keyword search over stored project memories with the same filter set as
// the recent list. An empty query is refused instead of matching everything.
import { renderProjectMemoryReport, searchProjectMemories } from '../utils/project-memory'

/** Rows per page when the caller does not ask for a window. */
const DEFAULT_SEARCH_LIMIT = 5

export async function projectMemorySearch(
  query: string,
  workspace?: string,
  topic?: string,
  kind?: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
  includeInactive: boolean = false
) {
  const normalizedQuery = query.trim()
  if (!normalizedQuery) {
    return reply('Project memory search query cannot be empty.')
  }

  const rows = searchProjectMemories({
    query: normalizedQuery,
    workspace,
    topic,
    kind,
    limit,
    includeInactive,
  })

  if (rows.length === 0) {
    return reply(`No project memories matched query: ${normalizedQuery}`)
  }

  const filters = [
    { key: 'workspace_filter', value: workspace },
    { key: 'topic_filter', value: topic },
    { key: 'kind_filter', value: kind },
    { key: 'include_inactive', value: includeInactive },
  ]

  return reply(
    renderProjectMemoryReport('project_memory_search', 'query_text', normalizedQuery, rows, filters)
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
