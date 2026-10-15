// Reads one indexed C# type out of the game source database and pulls its
// source text from disk. The game source path comes from the saved setup
// environment — never from the caller.
import { getDb } from '../utils/db'
import { getGamePaths } from '../utils/env'
import { readIndexedCsharpType } from '../utils/csharp-type-reader'

export async function readCsharpType(typeName: string) {
  const db = getDb()
  return readIndexedCsharpType({
    db,
    sourcePath: getGamePaths().sourcePath,
    typeName,
  })
}
