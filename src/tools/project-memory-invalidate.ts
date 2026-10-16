// Marks one stored project memory as inactive (wrong or superseded).
// The memory id is mandatory; an optional reason is stored alongside the
// invalidation for later audit.
import { invalidateProjectMemory, renderProjectMemoryReport } from '../utils/project-memory'

export async function projectMemoryInvalidate(memoryId: string, reason?: string) {
  const memory = invalidateProjectMemory(memoryId, reason)

  if (!memory) {
    return reply(`Project memory not found: ${memoryId}`)
  }

  return reply(
    renderProjectMemoryReport('project_memory_invalidate', 'memory_id', memory.memoryId, [memory])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
