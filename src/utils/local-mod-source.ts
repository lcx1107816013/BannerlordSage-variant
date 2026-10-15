/**
 * Thin "local mod" aliases over the generic mod-source workspace helpers.
 * The tools layer speaks in local-mod terms while the implementation lives
 * in `mod-source.ts`; this file keeps that naming boundary without adding
 * any logic of its own.
 */
import {
  countModSourceCSharpFiles,
  resolveModSourceWorkspace,
  walkModSourceCSharpFiles,
  type ModSourceWorkspace,
} from './mod-source'

export type LocalModSourceWorkspace = ModSourceWorkspace

export async function resolveLocalModSourceWorkspace(requestedRoot?: string): Promise<LocalModSourceWorkspace> {
  return resolveModSourceWorkspace(requestedRoot)
}

export async function countLocalModCSharpFiles(sourceRoot: string): Promise<number> {
  return countModSourceCSharpFiles(sourceRoot)
}

export async function* walkLocalModCSharpFiles(dir: string): AsyncGenerator<string> {
  yield* walkModSourceCSharpFiles(dir)
}
