// Harmony patch scaffold generator. Looks up the target type and method in
// the C# AST index, then emits a ready-to-edit Prefix/Postfix template with
// overload hints so the caller knows whether an instance parameter or a
// type array is needed.
import { getDb } from '../utils/db'

type MethodRow = {
  filePath: string
  signature: string
  isStatic: number
  memberKind: string
}

/** Separator between two overload hint comments in the emitted template. */
const OVERLOAD_HINT_SEPARATOR = '\n// \n'

/** Shown when the index holds no such method, so the scaffold still compiles. */
const MISSING_SIGNATURE_HINT =
  '// Method signature was not found in the AST index. Run bun run setup to rebuild the index first.'

export async function generateHarmonyPatch(className: string, methodName: string) {
  const db = getDb()
  const typeRow = db
    .query<any, any>(
      `
      SELECT fullName, filePath
      FROM csharp_types
      WHERE typeName = $name
      ORDER BY LENGTH(fullName), filePath
      LIMIT 1
    `
    )
    .get({ $name: className })

  if (!typeRow) {
    return textContent(`Type not found: ${className}`)
  }

  const methods = db
    .query<any, any>(
      `
      SELECT filePath, signature, isStatic, memberKind
      FROM csharp_methods
      WHERE typeFullName = $typeFullName
        AND memberName = $methodName
      ORDER BY startLine
    `
    )
    .all({
      $typeFullName: typeRow.fullName,
      $methodName: methodName,
    }) as MethodRow[]

  const instanceParamHint = buildInstanceParamHint(className, methods)
  const overloadHints = buildOverloadHints(methods)

  const patchTemplate = `// Auto-generated Harmony patch template
// Target type: ${typeRow.fullName}
// Source file: ${typeRow.filePath}

${overloadHints}

using HarmonyLib;
using System;

namespace YourModNamespace.Patches
{
    // If there are multiple overloads, switch to the HarmonyPatch overload
    // that includes a parameter type array.
    // [HarmonyPatch(typeof(${className}), "${methodName}", new Type[] { /* typeof(int), typeof(string) */ })]
    [HarmonyPatch(typeof(${className}), "${methodName}")]
    public static class ${sanitizeIdentifier(className)}_${sanitizeIdentifier(methodName)}_Patch
    {
        static void Prefix(${instanceParamHint}/* original method args */, /* ref ReturnType __result */)
        {
            // TODO: prefix logic
        }

        static void Postfix(${instanceParamHint}/* original method args */, /* ref ReturnType __result */)
        {
            // TODO: postfix logic
        }
    }
}
`

  return textContent(patchTemplate)
}

/** Wraps a rendered template in the single-text-content reply shape. */
function textContent(text: string) {
  return { content: [{ type: 'text' as const, text }] }
}

/**
 * The `__instance` parameter each patch method needs.
 *
 * A single non-static method settles it: emit the parameter outright. Several
 * overloads cannot be told apart statically, so a marker comment asks the
 * author to decide. If every overload is static, nothing is emitted at all.
 */
function buildInstanceParamHint(className: string, methods: MethodRow[]): string {
  const holdsOneInstanceMethod = methods.length === 1 && methods[0].isStatic === 0
  if (holdsOneInstanceMethod) {
    return `${className} __instance, `
  }

  const holdsAnyInstanceMethod = methods.some(method => method.isStatic === 0)
  if (holdsAnyInstanceMethod) {
    return `/* If this is an instance method, add ${className} __instance here. */ `
  }

  return ''
}

/** One hint comment per overload, or the missing-signature note when there are none. */
function buildOverloadHints(methods: MethodRow[]): string {
  if (methods.length === 0) {
    return MISSING_SIGNATURE_HINT
  }

  return methods.map(renderOverloadHint).join(OVERLOAD_HINT_SEPARATOR)
}

/**
 * A numbered signature line plus, when the parameter list was readable, the
 * type array that the HarmonyPatch overload form would need.
 */
function renderOverloadHint(method: MethodRow, position: number): string {
  const typeHint = buildTypeHint(method.signature)
  const lines = [`// [${position + 1}] ${method.signature}`]

  if (typeHint) {
    lines.push(`// Overload hint: new Type[] { ${typeHint} }`)
  }

  return lines.filter(Boolean).join('\n')
}

// Extracts the parameter type list from a C# method signature and renders it
// as a HarmonyPatch type array. Handles nested generics/parens/brackets so
// commas inside type arguments don't split parameters.
function buildTypeHint(signature: string): string {
  const openParen = signature.indexOf('(')
  const closeParen = signature.lastIndexOf(')')
  // No parameter list at all, or an empty `()` — both yield no hint.
  const hasParameterList = openParen !== -1 && closeParen !== -1 && closeParen > openParen + 1
  if (!hasParameterList) {
    return ''
  }

  const paramsSection = signature.slice(openParen + 1, closeParen).trim()
  if (!paramsSection) {
    return ''
  }

  return splitTopLevel(paramsSection)
    .map(extractTypeFromParam)
    .filter(Boolean)
    .map(typeName => `typeof(${typeName})`)
    .join(', ')
}

// Which delimiter opens each nesting level, and which closes it.
const DEPTH_OPENERS = new Set(['<', '(', '['])
const DEPTH_CLOSER_TO_OPENER = new Map([
  ['>', '<'],
  [')', '('],
  [']', '['],
])
const DEPTH_ZERO = new Map([
  ['<', 0],
  ['(', 0],
  ['[', 0],
])

/**
 * Splits a parameter list on the commas that sit at nesting depth zero, so a
 * comma inside `Dictionary<int, string>` or `int[,]` does not split anything.
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = []
  let current = ''
  const depth = new Map(DEPTH_ZERO)

  for (const char of input) {
    if (DEPTH_OPENERS.has(char)) {
      depth.set(char, depth.get(char) + 1)
    } else if (DEPTH_CLOSER_TO_OPENER.has(char)) {
      const opener = DEPTH_CLOSER_TO_OPENER.get(char)
      // An unmatched closer must not push the depth negative.
      depth.set(opener, Math.max(0, depth.get(opener) - 1))
    }

    const atTopLevel = depth.get('<') === 0 && depth.get('(') === 0 && depth.get('[') === 0
    if (char === ',' && atTopLevel) {
      if (current.trim()) {
        parts.push(current.trim())
      }
      current = ''
      continue
    }

    current += char
  }

  if (current.trim()) {
    parts.push(current.trim())
  }

  return parts
}

// "ref Foo bar" / "params int[] xs" / "Foo bar = default" -> "Foo" / "int[]".
// The type is whatever precedes the last space; a parameter with no space at
// all is the type on its own.
function extractTypeFromParam(param: string): string {
  const withoutDefault = param.split('=').shift()?.trim() || ''
  const cleaned = withoutDefault.replace(/^\s*(ref|out|in|params|this|scoped|readonly)\s+/g, '')
  const lastSpace = cleaned.lastIndexOf(' ')

  if (lastSpace === -1) {
    return cleaned
  }

  return cleaned.slice(0, lastSpace).trim()
}

function sanitizeIdentifier(input: string): string {
  return input.replace(/[^A-Za-z0-9_]/g, '_')
}
