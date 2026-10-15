// Lists files inside the mod source workspace. The directory is resolved
// through the mod-source helper first so every sandbox roots at the same
// place; the generic directory listing does the rest.
import { PathSandbox } from '../utils/path-sandbox'
import { ensureModSourceDir } from '../utils/mod-source'
import { listDirectory } from './list-directory'

export async function listModDirectory(workspaceRoot: string | undefined, relativePath: string = '') {
  const sourceDir = await ensureModSourceDir(workspaceRoot)
  return listDirectory(new PathSandbox(sourceDir), relativePath)
}
