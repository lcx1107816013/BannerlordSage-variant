/**
 * Answers "is the index ready to serve queries" for the active game,
 * honoring which artifacts the game profile actually requires.
 */
import { activeGameId, dbPath, defsPath, sourcePath } from './env'
import { countFilesInDirectory, directoryHasFiles, fileExists } from './bannerlord-setup'
import { getGameProfile } from './game-profiles'

type IndexRequirement = {
  key: 'source' | 'xml' | 'db'
  required: boolean
}

/** The artifacts the profile demands, with the probe that answers each one. */
function requiredArtifacts(profile: { requiresSource: boolean; requiresXml: boolean; requiresDb: boolean }): IndexRequirement[] {
  return [
    { key: 'source', required: profile.requiresSource },
    { key: 'xml', required: profile.requiresXml },
    { key: 'db', required: profile.requiresDb },
  ]
}

/** Cheap readiness probe: existence checks only, no per-file counting. */
export async function getInitializationReadiness(): Promise<{
  gameId: string
  ready: boolean
  dbExists: boolean
}> {
  const profile = getGameProfile(activeGameId)
  const [sourceReady, xmlReady, dbExists] = await Promise.all([
    profile.requiresSource ? directoryHasFiles(sourcePath) : Promise.resolve(false),
    profile.requiresXml ? directoryHasFiles(defsPath) : Promise.resolve(false),
    fileExists(dbPath),
  ])

  const satisfied: Record<IndexRequirement['key'], boolean> = {
    source: sourceReady,
    xml: xmlReady,
    db: dbExists,
  }

  return {
    gameId: activeGameId,
    ready: requiredArtifacts(profile).every(artifact => !artifact.required || satisfied[artifact.key]),
    dbExists,
  }
}

/** Detailed status: counts files in each artifact directory. */
export async function getInitializationStatus(): Promise<{
  gameId: string
  ready: boolean
  sourceFiles: number
  xmlFiles: number
  dbExists: boolean
}> {
  const profile = getGameProfile(activeGameId)
  const [sourceFiles, xmlFiles, dbExists] = await Promise.all([
    countFilesInDirectory(sourcePath),
    countFilesInDirectory(defsPath),
    fileExists(dbPath),
  ])

  const counts: Record<IndexRequirement['key'], number> = {
    source: sourceFiles,
    xml: xmlFiles,
    db: dbExists ? 1 : 0,
  }

  return {
    gameId: activeGameId,
    ready: requiredArtifacts(profile).every(artifact => !artifact.required || counts[artifact.key] > 0),
    sourceFiles,
    xmlFiles,
    dbExists,
  }
}
