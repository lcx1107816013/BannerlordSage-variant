// Bridge to the local mod C# index: resolves a type by name and returns the
// indexed result unchanged for the MCP layer.
import { readLocalModType } from '../utils/local-mod-csharp-index'

/** Delegation only, so the tool and the facade cannot drift in argument order. */
export async function readModType(workspaceRoot: string | undefined, typeName: string) {
  const indexed = await readLocalModType(workspaceRoot, typeName)
  return indexed
}
