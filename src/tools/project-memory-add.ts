// Persists a durable project memory for later sessions to recall. Empty
// text is rejected up front; everything else flows through the shared
// project-memory store and returns as a one-row report.
import { addProjectMemory, renderProjectMemoryReport } from '../utils/project-memory'

export async function projectMemoryAdd(
  text: string,
  workspace?: string,
  topic?: string,
  kind?: string,
  summary?: string,
  source?: string,
  tags?: string[],
  importance: number = 3
) {
  const normalizedText = text.trim()
  if (!normalizedText) {
    return { content: [{ type: 'text' as const, text: 'Cannot store an empty project memory.' }] }
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

  return {
    content: [
      {
        type: 'text' as const,
        text: renderProjectMemoryReport('project_memory_add', 'stored_memory_id', memory.memoryId, [memory]),
      },
    ],
  }
}
