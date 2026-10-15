// Bridge to the local mod C# index: resolves a type by name and returns the
// indexed result unchanged for the MCP layer.
import { readLocalModType } from '../utils/local-mod-csharp-index'

export async function readModType(workspaceRoot: string | undefined, typeName: string) {
  return readLocalModType(workspaceRoot, typeName)
}
