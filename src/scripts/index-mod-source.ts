import { buildCsharpIndexForWorkspace } from './index-csharp'
import {
  countModSourceCSharpFiles,
  MOD_SOURCE_IGNORED_DIRECTORY_NAMES,
  resolveModSourceWorkspace,
  type ModSourceWorkspace,
} from '../utils/mod-source'
import { readRevisionFile, writeRevisionFile } from '../utils/runtime-revision'

type CliOptions = {
  sourceDir?: string
  help: boolean
}

export type ModSourceIndexSummary = {
  workspace: ModSourceWorkspace
  csharpFileCount: number
  filesScanned: number
  changedFiles: number
  removedFiles: number
  typeCount: number
  memberCount: number
  sourceLocalizationCount: number
  sourceDir: string
  workspaceId: string
  dbPath: string
}

/**
 * Indexes a local mod's C# sources into its own workspace database. The
 * revision file is (re)written whenever content actually changed, or when
 * no revision exists yet, so downstream freshness checks can key on it.
 */
export async function buildModSourceIndex(sourceDir?: string): Promise<ModSourceIndexSummary> {
  const workspace = await resolveModSourceWorkspace(sourceDir)
  const csharpFileCount = await countModSourceCSharpFiles(workspace.sourceRoot)

  if (csharpFileCount <= 0) {
    throw new Error(`Mod source directory does not contain any .cs files: ${workspace.sourceRoot}`)
  }

  const result = await buildCsharpIndexForWorkspace({
    sourcePath: workspace.sourceRoot,
    dbPath: workspace.dbPath,
    csharpAstDumpPath: workspace.csharpAstDumpPath,
    label: `mod source C# AST index (${workspace.workspaceId})`,
    ignoreDirectoryNames: [...MOD_SOURCE_IGNORED_DIRECTORY_NAMES],
  })

  const contentChanged = result.changedFiles > 0 || result.removedFiles > 0
  const noRevisionYet = readRevisionFile(workspace.versionPath).length === 0
  if (contentChanged || noRevisionYet) {
    await writeRevisionFile(workspace.versionPath, new Date().toISOString())
  }

  console.log(`Mod source workspace root: ${workspace.workspaceRoot}`)
  console.log(`Mod source source root: ${workspace.sourceRoot}`)
  console.log(`Mod source workspace id: ${workspace.workspaceId}`)
  console.log(`Mod source database: ${workspace.dbPath}`)

  return {
    workspace,
    csharpFileCount,
    filesScanned: result.filesScanned,
    changedFiles: result.changedFiles,
    removedFiles: result.removedFiles,
    typeCount: result.totalTypeCount,
    memberCount: result.totalMemberCount,
    sourceLocalizationCount: result.totalSourceLocalizationCount,
    sourceDir: workspace.sourceRoot,
    workspaceId: workspace.workspaceId,
    dbPath: workspace.dbPath,
  }
}

export async function runModSourceIndex(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    printHelpAndExit()
  }

  await buildModSourceIndex(options.sourceDir)
}

/** Supports `--source-dir <path>`, `--source-dir=<path>`, and a bare path. */
function parseArgs(args: string[]): CliOptions {
  const result: CliOptions = {
    sourceDir: undefined,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--source-dir' && args[index + 1]) {
      result.sourceDir = args[index + 1]
      index += 1
      continue
    }

    if (arg.startsWith('--source-dir=')) {
      result.sourceDir = arg.slice('--source-dir='.length)
      continue
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true
      continue
    }

    if (!arg.startsWith('--') && !result.sourceDir) {
      result.sourceDir = arg
    }
  }

  return result
}

function printHelpAndExit(): never {
  console.log(`
Usage:
  bun run index:mod-source -- --source-dir "<MOD_SOURCE_DIR>"

Options:
  --source-dir <path>  Local mod source directory to index. If omitted, falls back to BANNERSAGE_MOD_SOURCE_DIR.
  --help, -h           Show this help text.
`)
  process.exit(0)
}

if (import.meta.main) {
  runModSourceIndex().catch(error => {
    console.error('Mod source indexing failed:', error)
    process.exit(1)
  })
}
