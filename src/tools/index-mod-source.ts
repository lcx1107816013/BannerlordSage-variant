// Builds or refreshes the local mod C# source index and reports the delta:
// reindexed files, removed files, and the type/member counts that the
// read/search tools consume.
import { renderAiTextReport } from '../utils/ai-text'
import { ensureLocalModSourceIndex } from '../utils/local-mod-csharp-index'

export async function indexModSource(workspaceRoot?: string) {
  const summary = await ensureLocalModSourceIndex(workspaceRoot)

  // The resolved workspace paths and the rebuild delta are two groups: the
  // first says WHERE the index lives, the second says WHAT this run did.
  const fields = [
    ...workspaceFields(summary.workspace),
    ...deltaFields(summary),
  ]

  const text = renderAiTextReport('local_mod_source_index', 'workspace_root', summary.workspace.workspaceRoot, [
    { header: 'index_summary', fields },
  ])

  return { content: [{ type: 'text' as const, text }] }
}

/** Where the workspace and its two roots landed after resolution. */
function workspaceFields(workspace: {
  workspaceRoot: string
  sourceRoot: string
  cacheRoot: string
}) {
  return [
    { key: 'workspace_root', value: workspace.workspaceRoot },
    { key: 'source_root', value: workspace.sourceRoot },
    { key: 'cache_root', value: workspace.cacheRoot },
  ]
}

/** What the rebuild changed, and how much of it is now indexed. */
function deltaFields(summary: {
  changedFiles: number
  removedFiles: number
  filesScanned: number
  typeCount: number
  memberCount: number
  sourceLocalizationCount: number
}) {
  return [
    { key: 'changed_files_reindexed', value: summary.changedFiles },
    { key: 'removed_files_detected', value: summary.removedFiles },
    { key: 'roslyn_files_scanned', value: summary.filesScanned },
    { key: 'indexed_type_count', value: summary.typeCount },
    { key: 'indexed_member_count', value: summary.memberCount },
    { key: 'indexed_source_localization_count', value: summary.sourceLocalizationCount },
  ]
}
