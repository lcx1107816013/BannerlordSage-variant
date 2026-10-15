// Snapshot of the local mod source index: active workspace, cache warmth,
// and what (if anything) is missing.
import { getLocalModSourceStatus } from '../utils/local-mod-csharp-index'

export async function modSourceStatus(workspaceRoot?: string) {
  return getLocalModSourceStatus(workspaceRoot)
}
