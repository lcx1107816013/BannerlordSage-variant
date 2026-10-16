/**
 * Facade over the per-workspace mod-source index. The heavy lifting
 * (building, status reporting, type reads) is delegated to the indexing
 * script and the shared C# type reader; this module binds them to the
 * "local mod" vocabulary and returns MCP-shaped content blocks.
 */
import { Database } from 'bun:sqlite'
import { buildModSourceIndex, type ModSourceIndexSummary } from '../scripts/index-mod-source'
import { readIndexedCsharpType } from './csharp-type-reader'
import { renderAiTextReport } from './ai-text'

export type LocalModSourceIndexSummary = ModSourceIndexSummary

/** Builds or refreshes the mod-source index for the workspace. */
export function ensureLocalModSourceIndex(workspaceRoot?: string): Promise<LocalModSourceIndexSummary> {
  return buildModSourceIndex(workspaceRoot)
}

/** Index status rendered as an MCP text content block. */
export async function getLocalModSourceStatus(workspaceRoot?: string) {
  const summary = await ensureLocalModSourceIndex(workspaceRoot)
  const { workspace } = summary

  // Row order is the contract here: the status report is compared field by
  // field downstream, so the summary block is written as an ordered list of
  // key/value pairs rather than a mapped object.
  const statusFields = [
    { key: 'workspace_root', value: workspace.workspaceRoot },
    { key: 'source_root', value: workspace.sourceRoot },
    { key: 'cache_root', value: workspace.cacheRoot },
    { key: 'csharp_file_count', value: summary.csharpFileCount },
    { key: 'changed_files_reindexed', value: summary.changedFiles },
    { key: 'removed_files_detected', value: summary.removedFiles },
    { key: 'indexed_type_count', value: summary.typeCount },
    { key: 'indexed_member_count', value: summary.memberCount },
    { key: 'indexed_source_localization_count', value: summary.sourceLocalizationCount },
  ]

  return {
    content: [
      {
        type: 'text' as const,
        text: renderAiTextReport('local_mod_source_status', 'workspace_root', workspace.workspaceRoot, [
          {
            header: 'workspace_summary',
            fields: statusFields,
          },
        ]),
      },
    ],
  }
}

/** Reads one indexed C# type (or the multi-match disambiguation report). */
export async function readLocalModType(workspaceRoot: string | undefined, typeName: string) {
  const summary = await ensureLocalModSourceIndex(workspaceRoot)
  const { workspace } = summary
  // Read-only: the caller only ever reads a type out of the index the call
  // above just built, so this handle must never create a missing file.
  const db = new Database(workspace.dbPath, { create: false, readonly: true })

  try {
    return await readIndexedCsharpType({
      db,
      sourcePath: workspace.sourceRoot,
      typeName,
      reportType: 'local_mod_type_read',
      queryLabel: 'query_type_name',
      notFoundText: `Type '${typeName}' was not found in the indexed mod source workspace (${workspace.sourceRoot}).`,
      topFields: [
        { key: 'workspace_root', value: workspace.workspaceRoot },
        { key: 'source_root', value: workspace.sourceRoot },
        { key: 'changed_files_reindexed', value: summary.changedFiles },
        { key: 'removed_files_detected', value: summary.removedFiles },
      ],
    })
  } finally {
    db.close()
  }
}
