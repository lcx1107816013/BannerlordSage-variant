type SmokeOptions = {
  gameDir?: string
  quick: boolean
  skipStart: boolean
  help: boolean
}

type SmokeCheck = {
  name: string
  command: string[]
  timeoutMs?: number
  /** Substring that must appear in the output before the process is killed. */
  expectText?: string
}

type CheckResult = {
  ok: boolean
  output: string
}

const DEFAULT_CHECK_TIMEOUT_MS = 30_000

/**
 * Release smoke: runs the documented CLI surfaces end-to-end. Without
 * `--game-dir` it validates only the cheap help/import checks; with a real
 * game directory it also exercises the full setup flow (slow, or a
 * single-DLL `--quick` variant) and the server's start readiness.
 */
export async function runReleaseSmoke(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)
  if (options.help) {
    printHelpAndExit()
  }

  const checks: SmokeCheck[] = baseChecks()

  if (options.gameDir) {
    checks.push(...gameDirChecks(options.gameDir, options))
  }

  let passed = 0
  for (const check of checks) {
    console.log(`\n[smoke] ${check.name}`)
    const result = await runCheck(check)
    if (!result.ok) {
      throw new Error(
        [`Smoke check failed: ${check.name}`, result.output.trim()].filter(Boolean).join('\n')
      )
    }

    passed += 1
    console.log(`[smoke] passed: ${check.name}`)
  }

  if (!options.gameDir) {
    console.log('\nSmoke checks passed. No --game-dir was provided, so the full local install flow was skipped.')
    console.log('Run `bun run smoke:release -- --game-dir "<path>"` to validate the documented local setup flow.')
    return
  }

  console.log(`\nSmoke checks passed: ${passed}`)
}

function baseChecks(): SmokeCheck[] {
  return [
    {
      name: 'setup help',
      command: ['bun', 'run', 'setup', '--', '--help'],
      timeoutMs: 30000,
    },
    {
      name: 'bannerlord setup help',
      command: ['bun', 'run', 'setup:bannerlord', '--', '--help'],
      timeoutMs: 30000,
    },
    {
      name: 'start import',
      // Importing the stdio module proves the server graph wires up; the
      // sentinel text lets us kill it before it waits for a client.
      command: ['bun', '-e', "import('./src/stdio.ts').then(() => console.log('stdio import ok'))"],
      timeoutMs: 30000,
      expectText: 'stdio import ok',
    },
  ]
}

function gameDirChecks(gameDir: string, options: SmokeOptions): SmokeCheck[] {
  const checks: SmokeCheck[] = [
    {
      name: 'scope report',
      command: ['bun', 'run', 'report:scopes', '--', '--game-dir', gameDir],
      timeoutMs: 2 * 60_000,
      expectText: 'DLL scopes',
    },
    {
      name: options.quick ? 'quick setup flow' : 'documented setup flow',
      command: buildSetupCommand(gameDir, options.quick),
      timeoutMs: options.quick ? 10 * 60_000 : 60 * 60_000,
      expectText: 'Setup complete.',
    },
  ]

  if (!options.skipStart && !options.quick) {
    checks.push({
      name: 'start readiness',
      command: ['bun', 'run', 'start'],
      timeoutMs: 15000,
      expectText: 'BannerlordSage MCP is ready and waiting for a client connection.',
    })
  }

  return checks
}

function buildSetupCommand(gameDir: string, quick: boolean): string[] {
  const base = ['bun', 'run', 'setup', '--', '--accept-disclaimer', '--game-dir', gameDir]
  if (!quick) {
    return base
  }

  return [...base, '--dll', 'TaleWorlds.CampaignSystem.dll', '--skip-xml', '--no-index']
}

/**
 * Walker supporting both `--flag value` and `--flag=value` spellings.
 */
function parseArgs(args: string[]): SmokeOptions {
  const result: SmokeOptions = {
    quick: false,
    skipStart: false,
    help: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]

    if (arg === '--game-dir' && args[index + 1]) {
      result.gameDir = args[index + 1]
      index += 1
      continue
    }

    if (arg.startsWith('--game-dir=')) {
      result.gameDir = arg.slice('--game-dir='.length)
      continue
    }

    if (arg === '--quick') {
      result.quick = true
      continue
    }

    if (arg === '--skip-start') {
      result.skipStart = true
      continue
    }

    if (arg === '--help' || arg === '-h') {
      result.help = true
    }
  }

  return result
}

function printHelpAndExit(): never {
  console.log(`
Usage:
  bun run smoke:release
  bun run smoke:release -- --game-dir "<BANNERLORD_GAME_DIR>"
  bun run smoke:release -- --game-dir "<BANNERLORD_GAME_DIR>" --quick

Options:
  --game-dir <path>  Run the documented setup flow against a real game installation.
  --quick            Validate a one-DLL setup flow without XML import, SQLite rebuild, or final start check.
  --skip-start       Skip the final start readiness check during a full smoke run.
  --help, -h         Show this help text.
`)
  process.exit(0)
}

/**
 * Runs one check to completion (or until the expect-text fires, at which
 * point the child is killed and the check counts as passed).
 */
async function runCheck(check: SmokeCheck): Promise<CheckResult> {
  const proc = Bun.spawn(check.command, {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const buffers = { stdout: '', stderr: '' }
  const pipes = [
    drainInto(proc.stdout, chunk => {
      buffers.stdout += chunk
    }),
    drainInto(proc.stderr, chunk => {
      buffers.stderr += chunk
    }),
  ]

  const timeoutMs = check.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  while (true) {
    const output = `${buffers.stdout}\n${buffers.stderr}`

    if (check.expectText && output.includes(check.expectText)) {
      proc.kill()
      await Promise.allSettled([...pipes, proc.exited])
      return { ok: true, output }
    }

    const exited = await Promise.race([
      proc.exited.then(() => true),
      sleep(200).then(() => false),
    ])

    if (exited) {
      await Promise.allSettled(pipes)
      const finalOutput = `${buffers.stdout}\n${buffers.stderr}`
      const code = await proc.exited
      return {
        ok: code === 0 && (!check.expectText || finalOutput.includes(check.expectText)),
        output: finalOutput,
      }
    }

    if (Date.now() > deadline) {
      proc.kill()
      await Promise.allSettled([...pipes, proc.exited])
      return {
        ok: false,
        output: `${buffers.stdout}\n${buffers.stderr}\nTimed out after ${timeoutMs}ms.`,
      }
    }
  }
}

/** Reads a stream to completion, forwarding decoded text chunks. */
async function drainInto(
  stream: ReadableStream<Uint8Array> | null,
  onChunk: (chunk: string) => void
): Promise<void> {
  if (!stream) return

  const reader = stream.getReader()
  const decoder = new TextDecoder()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        const tail = decoder.decode()
        if (tail) onChunk(tail)
        break
      }

      onChunk(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

if (import.meta.main) {
  runReleaseSmoke().catch(error => {
    console.error('Release smoke failed:', error)
    process.exit(1)
  })
}
