// Reads a slice of a file from the mod source workspace. Paging and
// sandboxing mirror readFile; only the root directory differs.
import { openModSourceSandbox } from './mod-source-sandbox'
import { readFile } from './read-file'

export async function readModFile(
  workspaceRoot: string | undefined,
  relativePath: string,
  startLine: number = 0,
  lineCount: number = 400
) {
  const sandbox = await openModSourceSandbox(workspaceRoot)
  return readFile(sandbox, relativePath, startLine, lineCount)
}
