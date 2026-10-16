// Sandbox-aware directory listing. Directories carry a trailing slash so
// plain-text output distinguishes them from files; output is sorted for
// determinism.
import { readdir } from 'node:fs/promises'
import { PathSandbox } from '../utils/path-sandbox'

/** Shown when the directory resolved but holds nothing. */
const EMPTY_DIRECTORY_TEXT = 'Directory is empty.'

export async function listDirectory(sandbox: PathSandbox, relativePath: string = '') {
  try {
    const resolvedDirectory = sandbox.validateAndResolve(relativePath)
    const entries = await readdir(resolvedDirectory, { withFileTypes: true })

    const listing = entries
      .map(nameWithDirectoryMarker)
      // A plain default sort, not localeCompare: the order must not depend on
      // the host's locale, and this compares UTF-16 code units.
      .sort()
      .join('\n')

    return { content: [{ type: 'text' as const, text: listing || EMPTY_DIRECTORY_TEXT }] }
  } catch {
    throw new Error(`Failed to list directory: ${relativePath}`)
  }
}

/** A directory is told apart from a file by its trailing slash. */
function nameWithDirectoryMarker(entry: { name: string; isDirectory(): boolean }): string {
  return entry.isDirectory() ? `${entry.name}/` : entry.name
}
