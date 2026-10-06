import { projectMemoryAdd } from './project-memory-add'
import { projectMemoryCaptureSession } from './project-memory-capture-session'
import { projectMemoryInvalidate } from './project-memory-invalidate'
import { projectMemoryRecent } from './project-memory-recent'
import { projectMemorySearch } from './project-memory-search'
import { projectMemoryWakeup } from './project-memory-wakeup'

function textError(message: string) {
  return { content: [{ type: 'text' as const, text: message }] }
}

export type MemoryReadAction = 'search' | 'recent' | 'wakeup'
export type MemoryWriteAction = 'add' | 'capture_session' | 'invalidate'

export interface MemoryReadInput {
  query?: string
  workspace?: string
  topic?: string
  kind?: string
  limit?: number
  includeInactive?: boolean
}

export interface MemoryWriteInput {
  text?: string
  memoryId?: string
  reason?: string
  workspace?: string
  topic?: string
  kind?: string
  summary?: string
  source?: string
  tags?: string[]
  importance?: number
  decisions?: string[]
  pitfalls?: string[]
  preferences?: string[]
  todos?: string[]
  notes?: string[]
  sessionImportance?: number
}

/** Read side of project memory: search, recent, wakeup. */
export async function projectMemoryRead(action: MemoryReadAction, input: MemoryReadInput) {
  switch (action) {
    case 'search':
      if (!input.query) return textError('project_memory_read(action="search") requires query.')
      return await projectMemorySearch(
        input.query,
        input.workspace,
        input.topic,
        input.kind,
        input.limit ?? 5,
        input.includeInactive ?? false
      )
    case 'recent':
      return await projectMemoryRecent(
        input.workspace,
        input.topic,
        input.kind,
        input.limit ?? 8,
        input.includeInactive ?? false
      )
    case 'wakeup':
      return await projectMemoryWakeup(input.workspace, input.limit ?? 8)
  }
}

/** Write side of project memory: add, capture_session, invalidate. */
export async function projectMemoryWrite(action: MemoryWriteAction, input: MemoryWriteInput) {
  switch (action) {
    case 'add':
      if (!input.text) return textError('project_memory_write(action="add") requires text.')
      return await projectMemoryAdd(
        input.text,
        input.workspace,
        input.topic,
        input.kind,
        input.summary,
        input.source,
        input.tags,
        input.importance ?? 3
      )
    case 'capture_session':
      return await projectMemoryCaptureSession(
        input.workspace,
        input.topic,
        input.source,
        input.summary,
        input.decisions,
        input.pitfalls,
        input.preferences,
        input.todos,
        input.notes,
        input.sessionImportance ?? 3
      )
    case 'invalidate':
      if (!input.memoryId) return textError('project_memory_write(action="invalidate") requires memoryId.')
      return await projectMemoryInvalidate(input.memoryId, input.reason)
  }
}
