// Text search across the mod source workspace. The workspace root goes
// through ensureModSourceDir first; the generic source search then applies
// the sandbox and pattern filters.
import { openModSourceSandbox } from './mod-source-sandbox'
import { searchSource } from './search-source'

export async function searchModSource(
  workspaceRoot: string | undefined,
  query: string,
  caseSensitive: boolean = false,
  filePattern?: string
) {
  const sandbox = await openModSourceSandbox(workspaceRoot)
  return searchSource(sandbox, query, caseSensitive, filePattern)
}
