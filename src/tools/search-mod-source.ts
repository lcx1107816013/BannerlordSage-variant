// Text search across the mod source workspace. The workspace root goes
// through ensureModSourceDir first; the generic source search then applies
// the sandbox and pattern filters.
import { PathSandbox } from '../utils/path-sandbox'
import { ensureModSourceDir } from '../utils/mod-source'
import { searchSource } from './search-source'

export async function searchModSource(
  workspaceRoot: string | undefined,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string
) {
  const sourceDir = await ensureModSourceDir(workspaceRoot)
  return searchSource(new PathSandbox(sourceDir), query, caseSensitive, filePattern)
}
