// Lists recently stored project memories, newest first, optionally filtered
// by workspace, topic, or kind. Invalidated memories stay hidden unless
// includeInactive is set.
import { listRecentProjectMemories, renderProjectMemoryReport } from '../utils/project-memory'

/** Rows per page when the caller does not ask for a window. */
const DEFAULT_RECENT_LIMIT = 8

export async function projectMemoryRecent(
  workspace?: string,
  topic?: string,
  kind?: string,
  limit: number = DEFAULT_RECENT_LIMIT,
  includeInactive: boolean = false
) {
  const rows = listRecentProjectMemories({
    workspace,
    topic,
    kind,
    limit,
    includeInactive,
  })

  if (rows.length === 0) {
    return reply('No project memories found.')
  }

  const filters = [
    { key: 'topic_filter', value: topic },
    { key: 'kind_filter', value: kind },
    { key: 'include_inactive', value: includeInactive },
  ]
  // An empty or absent workspace is reported as the 'all' scope.
  const renderedScope = workspace?.trim() || 'all'

  return reply(
    renderProjectMemoryReport('project_memory_recent', 'scope', renderedScope, rows, filters)
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
