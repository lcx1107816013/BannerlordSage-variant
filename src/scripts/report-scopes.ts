import { getGameProfile, type DllImportScope, type XmlImportScope } from '../utils/game-profiles'

type Options = {
  game: string
  gameDir?: string
  json: boolean
}

type ScopeReport = {
  game: string
  gameDir: string
  dllScopes: Record<DllImportScope, number>
  xmlScopes: Record<XmlImportScope, { files: number; includedModules: string[]; skippedModules: string[] }>
}

const DLL_SCOPES: DllImportScope[] = ['core', 'modding', 'official', 'all']
const XML_SCOPES: XmlImportScope[] = ['official', 'all']

/**
 * Reports how many DLLs / XML files each import scope would pull in for a
 * game profile, so operators can sanity-check scope flags before running a
 * full setup. `--json` emits the same data machine-readably.
 */
export async function runScopeReport(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  const profile = getGameProfile(options.game)
  const gameDir = options.gameDir ?? (await profile.detectGameDir())

  if (!gameDir) {
    throw new Error(
      `Could not detect a game directory for '${options.game}'. Pass --game-dir "<path>" explicitly.`
    )
  }

  if (!(await profile.looksLikeGameDir(gameDir))) {
    throw new Error(`Game directory does not match the '${options.game}' profile: ${gameDir}`)
  }

  const dllScopes = {} as Record<DllImportScope, number>
  for (const scope of DLL_SCOPES) {
    const files = await profile.collectDllCandidates(gameDir, { dllScope: scope })
    dllScopes[scope] = files.length
  }

  const xmlScopes = {} as ScopeReport['xmlScopes']
  for (const scope of XML_SCOPES) {
    const result = await profile.collectXmlFiles(gameDir, { xmlScope: scope })
    xmlScopes[scope] = {
      files: result.files.length,
      includedModules: result.includedModules.map(item => item.moduleName),
      skippedModules: result.skippedModules.map(item => item.moduleName),
    }
  }

  const report: ScopeReport = { game: options.game, gameDir, dllScopes, xmlScopes }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printHumanReport(report)
}

/**
 * Minimal CLI walker: supports both `--flag value` and `--flag=value`
 * forms without pulling in an argument-parsing dependency.
 */
function parseArgs(args: string[]): Options {
  const result: Options = {
    game: 'bannerlord',
    json: false,
  }

  const readValue = (flag: string): string | undefined => {
    const inline = args.find(arg => arg.startsWith(`${flag}=`))
    if (inline) {
      return inline.slice(flag.length + 1)
    }
    const index = args.indexOf(flag)
    return index !== -1 ? args[index + 1] : undefined
  }

  const game = readValue('--game')
  if (game) {
    result.game = game
  }

  const gameDir = readValue('--game-dir')
  if (gameDir) {
    result.gameDir = gameDir
  }

  if (args.includes('--json')) {
    result.json = true
  }

  return result
}

function printHumanReport(report: ScopeReport): void {
  console.log(`Game profile: ${report.game}`)
  console.log(`Game directory: ${report.gameDir}`)
  console.log('')
  console.log('DLL scopes')
  for (const scope of DLL_SCOPES) {
    console.log(`- ${scope}: ${report.dllScopes[scope]}`)
  }

  console.log('')
  console.log('XML scopes')
  for (const scope of XML_SCOPES) {
    const xml = report.xmlScopes[scope]
    console.log(`- ${scope}: files=${xml.files}, includedModules=${xml.includedModules.length}, skippedModules=${xml.skippedModules.length}`)
    if (xml.includedModules.length > 0) {
      console.log(`  included: ${xml.includedModules.join(', ')}`)
    }
    if (xml.skippedModules.length > 0) {
      console.log(`  skipped: ${xml.skippedModules.join(', ')}`)
    }
  }
}

if (import.meta.main) {
  runScopeReport().catch(error => {
    console.error('Scope report failed:', error)
    process.exit(1)
  })
}
