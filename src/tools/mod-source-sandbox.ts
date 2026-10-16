// One place that turns a caller-supplied workspace root into the sandbox the
// mod-source tools read through. `ensureModSourceDir` resolves (and, on first
// use, creates) the workspace's source directory, so every mod-source tool
// roots at the same place regardless of which one was called first.
import { PathSandbox } from '../utils/path-sandbox'
import { ensureModSourceDir } from '../utils/mod-source'

export async function openModSourceSandbox(workspaceRoot?: string): Promise<PathSandbox> {
  const sourceDir = await ensureModSourceDir(workspaceRoot)
  return new PathSandbox(sourceDir)
}
