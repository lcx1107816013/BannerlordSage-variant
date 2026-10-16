// Reads one indexed C# type out of the game source database and pulls its
// source text from disk. The game source path comes from the saved setup
// environment — never from the caller.
import { getDb } from '../utils/db'
import { getGamePaths } from '../utils/env'
import { readIndexedCsharpType } from '../utils/csharp-type-reader'

/**
 * The source root is taken from the persisted setup environment rather than
 * from the argument list, so a caller cannot point the reader at another tree:
 * only the type name is caller-controlled.
 */
export async function readCsharpType(typeName: string) {
  const db = getDb()
  const { sourcePath } = getGamePaths()

  return readIndexedCsharpType({ db, sourcePath, typeName })
}
