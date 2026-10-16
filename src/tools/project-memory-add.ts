// Persists a durable project memory for later sessions to recall. Empty
// text is rejected up front; everything else flows through the shared
// project-memory store and returns as a one-row report.
import { addProjectMemory, renderProjectMemoryReport } from '../utils/project-memory'

/** Importance assigned when the caller does not pick one. */
const DEFAULT_IMPORTANCE = 3

export async function projectMemoryAdd(
  text: string,
  workspace?: string,
  topic?: string,
  kind?: string,
  summary?: string,
  source?: string,
  tags?: string[],
  importance: number = DEFAULT_IMPORTANCE
) {
  const normalizedText = text.trim()
  if (!normalizedText) {
    return asText('Cannot store an empty project memory.')
  }

  const memory = addProjectMemory({
    text: normalizedText,
    workspace,
    topic,
    kind,
    summary,
    source,
    tags,
    importance,
  })

  return asText(
    renderProjectMemoryReport('project_memory_add', 'stored_memory_id', memory.memoryId, [memory])
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function asText(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
