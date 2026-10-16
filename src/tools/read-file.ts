// Paged file reader for the workspace sandbox. Every response wraps the
// requested slice in an ai-text report so the caller always knows which
// lines came back and whether more content follows.
import { PathSandbox } from '../utils/path-sandbox'
import { renderAiTextReport } from '../utils/ai-text'
import { readTextFileSlice } from '../utils/text-file-cache'

/** Lines returned when the caller does not ask for a window. */
const DEFAULT_LINE_COUNT = 400

export async function readFile(
  sandbox: PathSandbox,
  relativePath: string,
  startLine: number = 0,
  lineCount: number = DEFAULT_LINE_COUNT
) {
  try {
    const resolvedFile = sandbox.validateAndResolve(relativePath)
    const slice = await readTextFileSlice(resolvedFile, startLine, lineCount)
    const text = renderAiTextReport('file_read', 'query_relative_path', relativePath, [
      {
        header: 'file_slice',
        fields: [
          // The field is named `resolved_path` but deliberately reports the
          // RELATIVE path that was asked for — that is what downstream expects.
          { key: 'resolved_path', value: relativePath },
          // The raw request values, echoed unmodified: a negative start line or
          // line count renders as negative, and the window width below is
          // computed from the raw start line rather than from the first line
          // actually returned.
          { key: 'start_line_0based', value: startLine },
          { key: 'requested_line_count', value: lineCount },
          { key: 'returned_line_count', value: slice.endLineExclusive - startLine },
          { key: 'end_line_exclusive_0based', value: slice.endLineExclusive },
          { key: 'has_more', value: slice.hasMore ? 'true' : 'false' },
        ],
        multilineFields: [{ key: 'file_content', value: slice.text }],
      },
    ])

    return { content: [{ type: 'text' as const, text }] }
  } catch {
    // The original failure is deliberately reduced to this message: the caller
    // gets the relative path it asked for, without the sandbox's internals.
    throw new Error(`Failed to read file: ${relativePath}`)
  }
}
