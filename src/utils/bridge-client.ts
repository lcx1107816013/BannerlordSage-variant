// Direct Archive → Bridge invocation, without going through Core.
//
// WHY THIS EXISTS — the last unlinked pair in the toolchain.
//
// Core could already reach every module (`bc_call_tool` forwards to any of them), so the
// three libraries were reachable but not connected: Archive could describe a mod's source and
// its asset tree, Bridge could drive a running game, and nothing let one answer a question
// that needed the other. A modder asking "does the mod I just built actually load and patch
// cleanly?" had to call two servers and join the answers by hand.
//
// ★ THE MECHANISM IS A SUBPROCESS INVOKING THE PROJECT'S OWN CLI, NOT A NEW IPC CLIENT, AND
// THAT CHOICE IS THE WHOLE DESIGN.
//
// Three reasons, in order of weight:
//
//   1. The Bridge's control channel is a FILE IPC with a 120-second expiry gate on requests,
//      built specifically so a request left behind by a timed-out caller cannot be executed
//      later as a "ghost battle". Re-implementing that handshake here would mean two places
//      that must agree about expiry, cleanup and the ledger format. One of them would drift.
//   2. `bl_cmd.py` is the Bridge's own supported entry point and is already exercised by that
//      project's self-tests. Reaching past it to the protocol would skip every check it does.
//   3. Lexicon already does this (`be_bh_run_cli` is its documented escape hatch), so the
//      pattern is established rather than invented here.
//
// ★ WHAT THE SUBPROCESS BOUNDARY COSTS, STATED PLAINLY: errors arrive as text and an exit
// code rather than as typed exceptions, so the failure detail is coarser than an in-process
// call would give. That is the price of not sharing code across a module boundary, and it is
// paid deliberately — the alternative is the coupling the three-boundary rule exists to
// prevent.
//
// ★ IT IS NOT A GENERAL SHELL. Only a fixed set of Bridge actions is exposed, arguments are
// passed as an argv array (never through a shell), and every value is length-capped. A tool
// that forwards arbitrary commands would be a remote code execution surface wearing a helpful
// description, and this one exists to answer a specific question.

import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** The Bridge actions this tool will forward. Deliberately a closed list. */
export const BRIDGE_ACTIONS = [
  'ping',
  'status',
  'build-check',
  'patches',
  'patch-failures',
  'modules',
  'crash',
  'exceptions',
  'capability-probe',
] as const
export type BridgeAction = typeof BRIDGE_ACTIONS[number]

/** Actions that need the game running; the rest work against the log directory. */
const REQUIRES_GAME: ReadonlySet<BridgeAction> = new Set<BridgeAction>([
  'ping', 'status', 'patches', 'patch-failures', 'modules', 'crash', 'exceptions', 'capability-probe',
])

export const BRIDGE_MAX_ARG_LENGTH = 200
export const BRIDGE_TIMEOUT_MS = 60_000
export const BRIDGE_MAX_OUTPUT_BYTES = 2 * 1024 * 1024

export type BridgeInvocationResult = {
  action: string
  /** Process exit code; 0 ok, 1 the Bridge reported a failure, 2 a usage error. */
  exitCode: number
  /** Parsed JSON when the CLI produced it; null when it produced text or nothing. */
  payload: unknown | null
  stdout: string
  stderr: string
  /** Set when the call could not be attempted at all. */
  error?: string
}

export type BridgeInvocationOptions = {
  /** Directory containing `bl_cmd.py`. Defaults to BANNERSAGE_BRIDGE_DIR. */
  bridgeDir?: string
  /** Python interpreter; defaults to `python`, then `python3`. */
  python?: string
  /** Per-action flags, forwarded as `--name value` pairs. */
  flags?: Record<string, string | number | boolean>
}

/** Resolves the Bridge directory from the argument or the environment. */
export function resolveBridgeDir(provided?: string): string | undefined {
  const candidate = (provided ?? process.env.BANNERSAGE_BRIDGE_DIR ?? '').trim()
  if (!candidate) return undefined
  return isAbsolute(candidate) ? candidate : candidate
}

/**
 * Validates one flag value before it can reach argv.
 *
 * The cap matters because these values come from a model: an unbounded string is an
 * unbounded argv entry, and a value containing a newline or a NUL is a value that will not
 * survive the OS boundary intact.
 */
export function validateFlagValue(name: string, value: string | number | boolean): { ok: true; value: string } | { ok: false; reason: string } {
  const text = typeof value === 'boolean' ? String(value) : String(value)
  if (text.length > BRIDGE_MAX_ARG_LENGTH) {
    return { ok: false, reason: `${name} exceeds ${BRIDGE_MAX_ARG_LENGTH} characters` }
  }
  if (/[\0\r\n]/.test(text)) {
    return { ok: false, reason: `${name} contains a control character` }
  }
  return { ok: true, value: text }
}

/** Builds the argv for one invocation. Exported so tests can assert the shape. */
export function buildBridgeArgv(action: string, flags: Record<string, string | number | boolean> = {}): string[] {
  const argv = ['bl_cmd.py', action]
  for (const [name, value] of Object.entries(flags)) {
    argv.push(`--${name}`, String(value))
  }
  return argv
}

/**
 * Invokes one Bridge action through the project's own CLI.
 *
 * Never uses a shell: `spawn` with an argv array, so a value that looks like a shell
 * metacharacter is just a value.
 */
export async function invokeBridge(
  action: BridgeAction,
  options: BridgeInvocationOptions = {},
): Promise<BridgeInvocationResult> {
  if (!(BRIDGE_ACTIONS as readonly string[]).includes(action)) {
    return {
      action, exitCode: 2, payload: null, stdout: '', stderr: '',
      error: `unknown action ${action}; known: ${BRIDGE_ACTIONS.join(', ')}`,
    }
  }

  const bridgeDir = resolveBridgeDir(options.bridgeDir)
  if (!bridgeDir) {
    return {
      action, exitCode: 2, payload: null, stdout: '', stderr: '',
      error: 'bridge directory not configured: set BANNERSAGE_BRIDGE_DIR or pass bridgeDir (the folder containing bl_cmd.py)',
    }
  }

  const script = join(bridgeDir, 'bl_cmd.py')
  try {
    await access(script)
  } catch {
    return {
      action, exitCode: 2, payload: null, stdout: '', stderr: '',
      error: `bl_cmd.py not found in ${bridgeDir}`,
    }
  }

  // Validate every flag BEFORE building argv, so a rejected value never reaches the process.
  const safeFlags: Record<string, string> = {}
  for (const [name, value] of Object.entries(options.flags ?? {})) {
    const check = validateFlagValue(name, value)
    if (!check.ok) {
      return { action, exitCode: 2, payload: null, stdout: '', stderr: '', error: check.reason }
    }
    safeFlags[name] = check.value
  }

  const interpreters = options.python ? [options.python] : ['python', 'python3']
  let lastError = ''

  for (const interpreter of interpreters) {
    const outcome = await runOnce(interpreter, script, action, safeFlags)
    if (outcome.error && outcome.error.includes('ENOENT')) {
      lastError = `interpreter not found: ${interpreter}`
      continue
    }
    return outcome
  }

  return {
    action, exitCode: 2, payload: null, stdout: '', stderr: '',
    error: lastError || 'no python interpreter available',
  }
}

function runOnce(
  interpreter: string,
  script: string,
  action: string,
  flags: Record<string, string>,
): Promise<BridgeInvocationResult> {
  return new Promise(resolve => {
    const child = spawn(interpreter, [script, action, ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])], {
      cwd: script.slice(0, script.lastIndexOf(script.includes('\\') ? '\\' : '/')) || undefined,
      // No shell: values are values, not syntax.
      shell: false,
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let killedForSize = false

    const finish = (result: BridgeInvocationResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish({
        action, exitCode: 2, payload: null, stdout, stderr,
        error: `timed out after ${BRIDGE_TIMEOUT_MS}ms; the game may be busy or not running`,
      })
    }, BRIDGE_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > BRIDGE_MAX_OUTPUT_BYTES) {
        killedForSize = true
        try { child.kill() } catch { /* already gone */ }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', (error: NodeJS.ErrnoException) => {
      finish({ action, exitCode: 2, payload: null, stdout, stderr, error: error.message ?? String(error) })
    })

    child.on('close', (code: number | null) => {
      if (killedForSize) {
        finish({
          action, exitCode: 2, payload: null, stdout, stderr,
          error: `output exceeded ${BRIDGE_MAX_OUTPUT_BYTES} bytes and was stopped`,
        })
        return
      }
      finish({
        action,
        exitCode: code ?? 2,
        payload: extractJson(stdout),
        stdout,
        stderr,
      })
    })
  })
}

/**
 * Pulls the first complete JSON object out of the CLI's stdout.
 *
 * The CLI indents its JSON and may print other lines around it, so a whole-stdout parse is not
 * reliable. Scanning for a balanced object starting at the first `{` handles the indented case
 * without needing a schema.
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** True when the action needs a running game, for reporting why one failed. */
export function actionNeedsGame(action: BridgeAction): boolean {
  return REQUIRES_GAME.has(action)
}
