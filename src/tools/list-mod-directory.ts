// Lists files inside the mod source workspace. The directory is resolved
// through the mod-source helper first so every sandbox roots at the same
// place; the generic directory listing does the rest.
import { openModSourceSandbox } from './mod-source-sandbox'
import { listDirectory } from './list-directory'

export async function listModDirectory(workspaceRoot: string | undefined, relativePath: string = '') {
  const sandbox = await openModSourceSandbox(workspaceRoot)
  return listDirectory(sandbox, relativePath)
}
