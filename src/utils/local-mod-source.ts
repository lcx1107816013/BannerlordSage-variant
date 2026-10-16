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

// Each alias is written as a plain delegation rather than a re-export so the
// local-mod vocabulary stays greppable and the delegate target is explicit.
export function resolveLocalModSourceWorkspace(requestedRoot?: string): Promise<LocalModSourceWorkspace> {
  return resolveModSourceWorkspace(requestedRoot)
}

export function countLocalModCSharpFiles(sourceRoot: string): Promise<number> {
  return countModSourceCSharpFiles(sourceRoot)
}

export function walkLocalModCSharpFiles(dir: string): AsyncGenerator<string> {
  return walkModSourceCSharpFiles(dir)
}
