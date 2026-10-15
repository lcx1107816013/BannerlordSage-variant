import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { server } from './server'
import { closeDb } from './utils/db'
import { closeMemoryDb } from './utils/memory-db'
import { getInitializationReadiness, getInitializationStatus } from './utils/runtime-check'

/**
 * Blocks startup when the project has not gone through `setup` yet.
 * The printed status lines double as the operator's fix-up checklist.
 */
async function bailWhenUninitialized(): Promise<void> {
  const readiness = await getInitializationReadiness()
  if (readiness.ready) {
    return
  }

  const status = await getInitializationStatus()
  console.error('BannerlordSage has not been initialized yet.')
  console.error(
    [
      `- Active game profile: ${status.gameId}`,
      `- Decompiled source files: ${status.sourceFiles}`,
      `- Imported XML files: ${status.xmlFiles}`,
      `- SQLite index present: ${status.dbExists ? 'yes' : 'no'}`,
      '',
      `Run \`bun run setup -- --game ${status.gameId}\` first to import game assets, decompile DLLs, and build the indexes.`,
    ].join('\n')
  )
  process.exit(1)
}

/** Wires the MCP server onto stdio and tears the databases down on exit signals. */
export async function main() {
  await bailWhenUninitialized()

  const transport = new StdioServerTransport()
  await server.connect(transport)

  console.error('BannerlordSage MCP is ready and waiting for a client connection.')

  const shutdown = () => {
    console.error('Shutting down BannerlordSage...')
    closeDb()
    closeMemoryDb()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

if (import.meta.main) {
  main().catch(error => {
    console.error('Fatal startup error:', error)
    process.exit(1)
  })
}
