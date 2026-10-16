// Captures a whole working session as a set of durable memories: decisions,
// pitfalls, preferences, todos, and notes each become their own row under
// one shared topic/source. A session with nothing durable is refused.
import { captureProjectMemorySession, renderProjectMemoryReport } from '../utils/project-memory'

/** Importance assigned to every row of the session when the caller does not pick one. */
const DEFAULT_SESSION_IMPORTANCE = 3

/** The workspace name used when the caller supplies none. */
const DEFAULT_SESSION_WORKSPACE = 'bannerlordsage'

/** Shown when none of the six session buckets carried anything durable. */
const EMPTY_SESSION_TEXT =
  'No durable session memories were provided. Add at least one summary, decision, pitfall, preference, todo, or note.'

export async function projectMemoryCaptureSession(
  workspace?: string,
  topic?: string,
  source?: string,
  summary?: string,
  decisions?: string[],
  pitfalls?: string[],
  preferences?: string[],
  todos?: string[],
  notes?: string[],
  sessionImportance: number = DEFAULT_SESSION_IMPORTANCE
) {
  const rows = captureProjectMemorySession({
    workspace,
    topic,
    source,
    summary,
    decisions,
    pitfalls,
    preferences,
    todos,
    notes,
    sessionImportance,
  })

  if (rows.length === 0) {
    return reply(EMPTY_SESSION_TEXT)
  }

  const filters = [
    { key: 'topic', value: topic },
    { key: 'source', value: source },
  ]
  const renderedScope = workspace?.trim() || DEFAULT_SESSION_WORKSPACE

  return reply(
    renderProjectMemoryReport('project_memory_capture_session', 'workspace', renderedScope, rows, filters)
  )
}

/** Wraps a rendered report in the single-text-content reply shape. */
function reply(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}
