import { runSetup } from '../scripts/setup'

/**
 * `--game bannerlord` is the whole point of this entrypoint, so it also
 * supplies the profile's usual scope defaults unless the operator picked
 * their own. Flags may be written as `--flag value` or `--flag=value`.
 */
function hasFlag(args: string[], flagName: string): boolean {
  return args.some(arg => arg === flagName || arg.startsWith(`${flagName}=`))
}

function mergeBannerlordDefaults(args: string[]): string[] {
  const withDefaults = [...args]
  const apply = (flag: string, value: string) => {
    if (!hasFlag(withDefaults, flag)) {
      withDefaults.unshift(value)
      withDefaults.unshift(flag)
    }
  }

  apply('--game', 'bannerlord')
  apply('--dll-scope', 'core')
  apply('--xml-scope', 'official')

  return withDefaults
}

if (import.meta.main) {
  process.env.BANNERSAGE_GAME = 'bannerlord'
  runSetup(mergeBannerlordDefaults(process.argv.slice(2))).catch(error => {
    console.error('Bannerlord setup failed:', error)
    process.exit(1)
  })
}
