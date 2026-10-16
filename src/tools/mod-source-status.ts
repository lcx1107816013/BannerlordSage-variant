// Snapshot of the local mod source index: active workspace, cache warmth,
// and what (if anything) is missing.
import { getLocalModSourceStatus } from '../utils/local-mod-csharp-index'

/**
 * Delegation only. The facade resolves the workspace and renders the report;
 * nothing is added or reshaped here, so the two cannot drift.
 */
export async function modSourceStatus(workspaceRoot?: string) {
  const status = await getLocalModSourceStatus(workspaceRoot)
  return status
}
