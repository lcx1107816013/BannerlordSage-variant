// Static Harmony-patch conflict analysis across several mods.
//
// WHY THIS EXISTS — the gap it fills is BETWEEN two things that already worked.
//
//   `ba_doctor` (Archive, static)   reads a module tree and reports dependency problems,
//                                   duplicate shared DLLs, load-order cycles. It answers
//                                   "will these modules load", not "will they work together".
//   `bl_patches` (Bridge, runtime)   introspects a LIVE game and reports who patched which
//                                   method. It needs the game running, and it can only tell
//                                   you about conflicts that already happened.
//
// Nothing connected them. Between "these modules declare compatible dependencies" and "a
// running process shows two owners on one method" lies the question a modder actually asks
// before launching: WHICH mods are going to fight over the same method? That is answerable
// from source, and it is the part of multi-mod verification that does not need the game.
//
// THE RULE THAT MAKES IT WORTH DOING: two mods patching the same method is a real risk, but
// the severity differs sharply by patch KIND, and that distinction is the whole value:
//
//   Transpiler vs Transpiler  most dangerous — both rewrite IL, and the combination can be
//                             invalid IL rather than a wrong result.
//   any vs Finalizer           a finalizer wraps the whole invocation; stacking is rarely
//                             intended.
//   Prefix/Postfix overlap    usually tolerable and often deliberate, but worth naming.
//
// WHAT IT DOES NOT DO: it does not run anything, and it does not prove a conflict will
// happen. It reads declarations. A patch can be conditional at runtime, a mod may be
// disabled, and a transpiler may compose harmlessly. The report says "these declarations
// compete", names the evidence, and stops — because the alternative is a tool that claims
// certainty about runtime behaviour it never observed.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

export type PatchKind = 'prefix' | 'postfix' | 'transpiler' | 'finalizer' | 'unknown'

export type PatchDeclaration = {
  /** Which mod directory the declaration came from. */
  moduleId: string
  /** Path relative to the scanned root. */
  filePath: string
  /** Line number of the attribute, for the evidence trail. */
  line: number
  /** Target type as written, e.g. `Hero` or `TaleWorlds.CampaignSystem.Hero`. */
  targetType: string
  /** Target method as written; empty when the attribute names only a type. */
  targetMethod: string
  /** Which Harmony patch methods this class declares. */
  kinds: PatchKind[]
}

export type PatchConflict = {
  targetType: string
  targetMethod: string
  /** Distinct owners competing for this target. */
  owners: string[]
  /** The most dangerous pairing present, by kind. */
  severity: 'transpiler_clash' | 'finalizer_overlap' | 'prefix_postfix_overlap'
  /** One line per owner, for the report. */
  evidence: string[]
}

export type PatchScanResult = {
  root: string
  declarations: PatchDeclaration[]
  conflicts: PatchConflict[]
  /** Files skipped because they were unreadable, so a low count has a reason. */
  skippedFiles: string[]
}

// ── the attribute grammar ───────────────────────────────────────────────────
//
// Harmony's attribute accepts several shapes, and the parser handles the ones that occur in
// real mods rather than one canonical form:
//
//   [HarmonyPatch(typeof(Hero), "CanBecomePrisoner")]
//   [HarmonyPatch(typeof(Hero), nameof(Hero.CanBecomePrisoner))]
//   [HarmonyPatch(typeof(Hero))]
//   [HarmonyPatch("Hero", "CanBecomePrisoner")]          string type name
//   [HarmonyPatch(typeof(Hero), "Method", new Type[] { typeof(int) })]
//
// The `nameof(...)` form is WHY THIS IS NOT A REGEX: the method name is written as a C#
// expression, and a regex that only matches quoted strings silently misses every mod that
// uses the idiom the engine's own docs recommend. Measured: the project's own mod-workspace
// template emits `nameof(Hero.CanBecomePrisoner)`.

const ATTRIBUTE = /\[HarmonyPatch\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)\s*\]/g

/** Extracts the target from the attribute's argument list. */
export function parseHarmonyPatchArguments(args: string): { targetType: string; targetMethod: string } {
  const parts = splitTopLevel(args)
  let targetType = ''
  let targetMethod = ''

  if (parts.length > 0) {
    const first = parts[0].trim()
    const typeofMatch = /^typeof\s*\(\s*([\w.<>\[\]]+)\s*\)$/.exec(first)
    if (typeofMatch) {
      targetType = typeofMatch[1]
    } else {
      const quoted = /^["']([^"']+)["']$/.exec(first)
      if (quoted) targetType = quoted[1]
    }
  }

  if (parts.length > 1) {
    const second = parts[1].trim()
    const nameofMatch = /^nameof\s*\(\s*[\w.]*?(\w+)\s*\)$/.exec(second)
    if (nameofMatch) {
      targetMethod = nameofMatch[1]
    } else {
      const quoted = /^["']([^"']+)["']$/.exec(second)
      if (quoted) targetMethod = quoted[1]
    }
  }

  return { targetType, targetMethod }
}

/** Splits on commas that are not inside parentheses, brackets, or quotes. */
export function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | null = null
  let current = ''

  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) out.push(current)
  return out
}

const KIND_ATTRIBUTES: Array<[RegExp, PatchKind]> = [
  [/\[Harmony(?:Prefix)\b/, 'prefix'],
  [/\[Harmony(?:Postfix)\b/, 'postfix'],
  [/\[Harmony(?:Transpiler)\b/, 'transpiler'],
  [/\[Harmony(?:Finalizer)\b/, 'finalizer'],
]

/**
 * Scans one mod's source files for patch declarations.
 *
 * Only `.cs` files are read, and the walk is depth-limited by the same prune list the asset
 * index uses, so a mod repository's build output cannot dominate the result.
 */
export async function scanPatchDeclarations(
  modRoot: string,
  moduleId: string,
  filePaths: string[],
): Promise<{ declarations: PatchDeclaration[]; skipped: string[] }> {
  const declarations: PatchDeclaration[] = []
  const skipped: string[] = []

  for (const rel of filePaths) {
    const full = join(modRoot, rel)
    let text: string
    try {
      text = await readFile(full, 'utf8')
    } catch {
      skipped.push(rel)
      continue
    }

    const kinds: PatchKind[] = []
    for (const [pattern, kind] of KIND_ATTRIBUTES) {
      if (pattern.test(text)) kinds.push(kind)
    }
    if (kinds.length === 0) continue

    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (!line.includes('HarmonyPatch')) continue
      // The attribute may wrap onto following lines; join a small window so a multi-line
      // attribute is parsed rather than skipped. Three lines covers the forms seen in real
      // mods without swallowing a neighbouring attribute.
      const window = lines.slice(i, i + 3).join(' ')
      ATTRIBUTE.lastIndex = 0
      const m = ATTRIBUTE.exec(window)
      if (!m) continue
      const { targetType, targetMethod } = parseHarmonyPatchArguments(m[1])
      if (!targetType && !targetMethod) continue
      declarations.push({
        moduleId,
        filePath: rel.split('\\').join('/'),
        line: i + 1,
        targetType,
        targetMethod,
        kinds,
      })
    }
  }

  return { declarations, skipped }
}

/** Severity ordering: higher wins when reporting which clash a target has. */
const SEVERITY_RANK: Record<PatchConflict['severity'], number> = {
  transpiler_clash: 3,
  finalizer_overlap: 2,
  prefix_postfix_overlap: 1,
}

/**
 * Groups declarations by target and reports the ones with more than one owner.
 *
 * A target is keyed by type AND method. A type-only patch (no method named) is keyed
 * separately from a method patch even on the same type, because Harmony treats them
 * differently and merging them would manufacture conflicts that do not exist.
 */
export function findPatchConflicts(declarations: PatchDeclaration[]): PatchConflict[] {
  const byTarget = new Map<string, PatchDeclaration[]>()
  for (const d of declarations) {
    const key = `${d.targetType.toLowerCase()}::${d.targetMethod.toLowerCase()}`
    const list = byTarget.get(key) ?? []
    list.push(d)
    byTarget.set(key, list)
  }

  const conflicts: PatchConflict[] = []
  for (const group of byTarget.values()) {
    const owners = [...new Set(group.map(d => d.moduleId))]
    // Two patching methods inside ONE mod is that mod's business; the question here is
    // multi-mod. Single-owner targets are not conflicts and are not reported.
    if (owners.length < 2) continue

    const allKinds = new Set(group.flatMap(d => d.kinds))
    const transpilerOwners = new Set(
      group.filter(d => d.kinds.includes('transpiler')).map(d => d.moduleId),
    )

    let severity: PatchConflict['severity'] = 'prefix_postfix_overlap'
    if (transpilerOwners.size >= 2) severity = 'transpiler_clash'
    else if (allKinds.has('finalizer') && owners.length >= 2) severity = 'finalizer_overlap'

    conflicts.push({
      targetType: group[0].targetType,
      targetMethod: group[0].targetMethod,
      owners: owners.sort(),
      severity,
      evidence: group
        .sort((a, b) => a.moduleId.localeCompare(b.moduleId) || a.line - b.line)
        .map(d => `${d.moduleId}: ${d.filePath}:${d.line}  [${d.kinds.join(',')}]`),
    })
  }

  // Worst first, then alphabetically so repeated runs agree.
  return conflicts.sort((a, b) => {
    const rank = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    if (rank !== 0) return rank
    return `${a.targetType}.${a.targetMethod}`.localeCompare(`${b.targetType}.${b.targetMethod}`)
  })
}

/** Collects `.cs` files under a root, skipping the usual build-output directories. */
export async function collectCsharpFiles(root: string, limit = 4000): Promise<string[]> {
  const PRUNE = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs', '.idea', '__pycache__'])
  const found: string[] = []

  const walk = async (dir: string): Promise<void> => {
    if (found.length >= limit) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= limit) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (PRUNE.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.cs')) {
        found.push(relative(root, full).split('\\').join('/'))
      }
    }
  }

  try {
    if ((await stat(root)).isDirectory()) await walk(root)
  } catch {
    /* root missing: return empty, the caller reports it */
  }
  return found.sort()
}
