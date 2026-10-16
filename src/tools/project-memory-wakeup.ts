// Session-start recall: pulls the highest-importance active memories for a
// workspace so an agent can load prior context before starting new work.
import { getProjectMemoryWakeup, renderProjectMemoryReport } from '../utils/project-memory'

/** Rows per page when the caller does not ask for a window. */
const DEFAULT_WAKEUP_LIMIT = 8

export async function projectMemoryWakeup(workspace?: string, limit: number = DEFAULT_WAKEUP_LIMIT) {
  const rows = getProjectMemoryWakeup(workspace, limit)

  if (rows.length === 0) {
    // ★ The two messages disagree about the fallback name ON PURPOSE, and both
    //   are contract: the empty-result sentence substitutes the project name
    //   'bannerlordsage', while the rendered report below uses 'all'.
    return reply(`No active wake-up memories found for workspace: ${workspace?.trim() || 'bannerlordsage'}`)
  }

  const renderedScope = workspace?.trim() || 'all'

  return reply(renderProjectMemoryReport('project_memory_wakeup', 'workspace', renderedScope, rows))
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
