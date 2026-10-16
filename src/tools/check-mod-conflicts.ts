// MCP tool: static multi-mod Harmony patch conflict analysis.
//
// THE QUESTION IT ANSWERS: "these mods are installed together — which of them are going to
// fight over the same method?" That is answerable from source, before the game starts, and
// nothing in the toolchain answered it. `ba_doctor` covers module loading; `bl_patches`
// covers a running process. This covers the middle: what the declarations say they will do.
//
// THE REPORT LEADS WITH SEVERITY, NOT WITH COUNTS. A list of conflicts sorted by target name
// buries the one that matters — two transpilers on one method, where the failure mode is
// invalid IL rather than a wrong result. The ordering is transpiler clash first, then
// finalizer overlap, then plain prefix/postfix overlap, because that is the order a modder
// should investigate them in.
//
// IT SAYS WHAT IT DID NOT DO. No game is started, no assembly is loaded, and a declaration
// is not proof of a live patch. A mod can be disabled or its patch conditional at runtime.
// The report states the boundary instead of implying certainty it has not earned.

import { renderAiTextReport } from '../utils/ai-text'
import { stat } from 'node:fs/promises'
import {
  collectCsharpFiles,
  findPatchConflicts,
  scanPatchDeclarations,
  type PatchDeclaration,
} from '../utils/harmony-patch-scan'

export type CheckModConflictsInput = {
  /** One or more mod source directories. Each is treated as one module. */
  modDirs: string[]
  /** Optional ids parallel to modDirs; defaults to the directory's own name. */
  moduleIds?: string[]
  /** Report every declaration, not only the competing ones. */
  includeDeclarations?: boolean
}

export async function checkModConflicts(input: CheckModConflictsInput) {
  const modDirs = (input.modDirs ?? []).filter(d => (d ?? '').trim())
  if (modDirs.length === 0) {
    return report('(none)', [{ key: 'error', value: 'modDirs must contain at least one directory' }])
  }
  if (modDirs.length === 1) {
    // Not an error, but the whole point is cross-mod, and a one-mod run that reports "no
    // conflicts" reads like a clean bill of health for a question that was never asked.
    return report(modDirs[0], [{
      key: 'note',
      value: 'only one mod given: conflicts are by definition between mods, so this can only report declarations',
    }], [], true)
  }

  const allDeclarations: PatchDeclaration[] = []
  const perModule: Array<{ moduleId: string; dir: string; declarations: number; read: boolean }> = []
  const skippedFiles: string[] = []

  for (let i = 0; i < modDirs.length; i++) {
    const dir = modDirs[i].trim()
    const moduleId = (input.moduleIds?.[i] ?? '').trim() || basenameOf(dir)

    let readable = false
    try {
      readable = (await stat(dir)).isDirectory()
    } catch {
      readable = false
    }
    if (!readable) {
      perModule.push({ moduleId, dir, declarations: 0, read: false })
      continue
    }

    const files = await collectCsharpFiles(dir)
    const { declarations, skipped } = await scanPatchDeclarations(dir, moduleId, files)
    allDeclarations.push(...declarations)
    skippedFiles.push(...skipped)
    perModule.push({ moduleId, dir, declarations: declarations.length, read: true })
  }

  const unreadable = perModule.filter(m => !m.read)
  const conflicts = findPatchConflicts(allDeclarations)

  const fields = [
    { key: 'mod_count', value: modDirs.length },
    { key: 'declarations_found', value: allDeclarations.length },
    { key: 'conflict_count', value: conflicts.length },
    { key: 'transpiler_clashes', value: conflicts.filter(c => c.severity === 'transpiler_clash').length },
    ...(unreadable.length > 0
      ? [{ key: 'unreadable_modules', value: unreadable.map(m => m.moduleId).join(', ') }]
      : []),
  ]

  const lists = [
    { key: 'conflicts', values: conflicts.length > 0 ? conflicts.flatMap(describeConflict) : ['(none found)'] },
    {
      key: 'per_module',
      values: perModule.map(m =>
        m.read ? `${m.moduleId}: ${m.declarations} declaration(s)` : `${m.moduleId}: NOT READABLE (${m.dir})`,
      ),
    },
    {
      key: 'boundaries',
      values: [
        'Static analysis: no game was started and no assembly was loaded.',
        'A declaration is not proof of a live patch - a mod may be disabled, or its patch conditional at runtime.',
        'Use bl_patches in a running game to confirm what actually took effect.',
        ...(skippedFiles.length > 0 ? [`${skippedFiles.length} file(s) could not be read.`] : []),
      ],
    },
  ]

  if (input.includeDeclarations) {
    lists.push({
      key: 'declarations',
      values: allDeclarations
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.filePath.localeCompare(b.filePath))
        .map(d => `${d.moduleId}: ${d.targetType}${d.targetMethod ? '.' + d.targetMethod : ''}  [${d.kinds.join(',')}]  ${d.filePath}:${d.line}`),
    })
  }

  return report(modDirs.join(', '), fields, lists)
}

function describeConflict(c: {
  targetType: string
  targetMethod: string
  owners: string[]
  severity: string
  evidence: string[]
}): string[] {
  const target = `${c.targetType}${c.targetMethod ? '.' + c.targetMethod : ''}`
  return [
    `[${c.severity}] ${target}  owners: ${c.owners.join(', ')}`,
    ...c.evidence.map(e => `    ${e}`),
  ]
}

function basenameOf(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || dir
}

function report(
  queryValue: string,
  fields: Array<{ key: string; value: string | number | boolean }>,
  lists: Array<{ key: string; values: string[] }> = [],
  noteOnly = false,
) {
  return {
    content: [
      {
        type: 'text' as const,
        text: renderAiTextReport(
          'check_mod_conflicts',
          noteOnly ? 'modDirs' : 'modDirs',
          queryValue,
          [{ fields, listFields: lists }],
          [],
        ),
      },
    ],
  }
}
