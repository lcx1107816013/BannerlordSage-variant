// Direct Archive → Lexicon invocation, without going through Core.
//
// WHY THIS EXISTS: THE LAST MISSING EDGE
// --------------------------------------
// The toolchain has four modules and three edges were already wired:
//
//     Archive -> Bridge   ba_bridge_query      (does the mod I built actually load?)
//     Bridge  -> Archive  bl_archive_symbols   (what does this crash symbol's code say?)
//     Lexicon -> Archive  be_archive_query     (is this key defined anywhere else?)
//
// Archive -> Lexicon was the gap, and it is not a symmetric one: Archive holds the
// AUTHORITATIVE text (XML, decompiled C#, game data), Lexicon holds the TRANSLATIONS.
// A token like `{=P1rL28RT}Sumpter Horse` can be resolved HERE to its English string,
// but whether somebody translated it, into which language, and whether that
// translation is still current lives THERE. Until now that join had to be done by hand
// across two MCP servers.
//
// ★ THE MECHANISM IS A SUBPROCESS, AND WHICH FILE IT RUNS IS THE IMPORTANT PART.
//
// This is the third cross-module client in the project and the first one whose target
// could not be run from source. The reason is worth recording, because guessing wrong
// here produced three consecutive false diagnoses:
//
//   * `node bin/bannerlord-helper.ts`  -> node cannot load .ts at all
//   * `ts-node bin/bannerlord-helper.ts` -> ERR_UNSUPPORTED_DIR_IMPORT
//
// The second failure is not a misconfiguration. Lexicon is `"type": "module"`, its
// tsconfig uses `moduleResolution: "Bundler"`, and the source tree contains ~318
// directory imports (`from '../src'`, `from './commands'`). That is legal for a
// bundler and illegal for Node's ESM resolver, so the SOURCE TREE IS NOT RUNNABLE BY
// DESIGN. `npm run dev` fails the same way — measured on this checkout.
//
// Therefore the runnable artefact is the bundled build: `dist/bannerlord-helper.js`.
// This client runs that, and says so when it is missing rather than reporting the
// module as broken.
//
// ★ THE COST, STATED: this client depends on Lexicon having been built. If `dist/` is
//   absent it returns a message naming `npm run build` instead of a stack trace, and it
//   does NOT try to run the source as a fallback — a fallback that cannot work would
//   only turn a clear "not built" into a confusing "broken".
//
// ★ NOT A GENERAL SHELL: closed action list, argv array, no shell, length-capped
//   values. A tool that forwarded arbitrary arguments to another module's CLI would be
//   a code-execution surface with a helpful description.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/**
 * The actions this tool may forward. Deliberately closed, and the names are Lexicon's
 * OWN CLI subcommands — verified with `bh --help`, not invented.
 *
 * The first version of this list said `list-languages` / `list-modules`, which do not
 * exist; the CLI answered `exit 2` and the tool would have reported "Lexicon is broken"
 * for a wrong guess about its interface. The real commands are:
 *     search / info / identifier / generate / translate / external /
 *     language / package / completion
 *
 * Only the read-only ones are exposed. `generate`, `translate`, `external` and
 * `package` write to a module directory; Archive has no business triggering a write
 * elsewhere while looking up a string.
 */
export const LEXICON_ACTIONS = ['language', 'info'] as const;
export type LexiconAction = (typeof LEXICON_ACTIONS)[number];

/** Commands that PROMPT and therefore cannot run headless. */
export const LEXICON_INTERACTIVE_ACTIONS = ['info'] as const;

export const LEXICON_MAX_ARG_LENGTH = 300;
export const LEXICON_TIMEOUT_MS = 60_000;
export const LEXICON_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

export type LexiconInvocationResult = {
  action: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type LexiconInvocationOptions = {
  /** Lexicon checkout root. Defaults to BANNERSAGE_LEXICON_DIR. */
  lexiconDir?: string;
  /** Entry script relative to lexiconDir. Defaults to the BUILT bundle. */
  entry?: string;
  /** Flags forwarded as `--name value`. */
  flags?: Record<string, string | number | boolean>;
};

export function resolveLexiconDir(provided?: string): string | undefined {
  const candidate = (provided ?? process.env.BANNERSAGE_LEXICON_DIR ?? '').trim();
  if (!candidate) return undefined;
  return isAbsolute(candidate) ? candidate : candidate;
}

/**
 * Strip ANSI SGR sequences.
 *
 * NOT cosmetic: `bh language` renders a chalk table, so raw stdout is mostly escape
 * codes. Forwarding them spends tokens on formatting and makes the data harder to read
 * than the data itself. Only colour/style sequences are removed; cursor-movement codes
 * would indicate the command went interactive, which is refused rather than cleaned.
 */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

/** Validate one flag value before it can reach argv. */
export function validateLexiconFlag(
  name: string,
  value: string | number | boolean,
): { ok: true; value: string } | { ok: false; reason: string } {
  const text = String(value);
  if (text.length > LEXICON_MAX_ARG_LENGTH) {
    return { ok: false, reason: `${name} exceeds ${LEXICON_MAX_ARG_LENGTH} characters` };
  }
  if (/[\0\r\n]/.test(text)) {
    return { ok: false, reason: `${name} contains a control character` };
  }
  return { ok: true, value: text };
}

/** Build the argv for one invocation. Exported so tests can assert the shape. */
export function buildLexiconArgv(
  action: string,
  entry: string,
  flags: Record<string, string | number | boolean> = {},
): string[] {
  const argv = [entry, action];
  for (const [name, value] of Object.entries(flags)) {
    argv.push(`--${name}`, String(value));
  }
  return argv;
}

const BUILD_HINT =
  'Lexicon has not been built. Run `npm run build` in the Lexicon checkout ' +
  '(the built bundle is dist/bannerlord-helper.js). The SOURCE tree cannot be run ' +
  'directly: the package is ESM and its sources use directory imports, which Node ' +
  'rejects — that is why `npm run dev` fails too.';

/** Invoke one read-only Lexicon query. Never uses a shell. */
export async function invokeLexicon(
  action: LexiconAction | string,
  options: LexiconInvocationOptions = {},
): Promise<LexiconInvocationResult> {
  if (!(LEXICON_ACTIONS as readonly string[]).includes(action)) {
    return {
      action, exitCode: 2, stdout: '', stderr: '',
      error: `unknown action ${action}; known: ${LEXICON_ACTIONS.join(', ')}`,
    };
  }

  const lexiconDir = resolveLexiconDir(options.lexiconDir);
  if (!lexiconDir) {
    return {
      action, exitCode: 2, stdout: '', stderr: '',
      error: 'lexicon directory not configured: set BANNERSAGE_LEXICON_DIR or pass lexiconDir',
    };
  }

  // Default to the BUILT bundle. `entry` stays overridable for a checkout laid out
  // differently, but the default must be the artefact that actually runs.
  const entry = options.entry ?? join('dist', 'bannerlord-helper.js');
  const entryPath = join(lexiconDir, entry);
  if (!existsSync(entryPath)) {
    return { action, exitCode: 2, stdout: '', stderr: '', error: BUILD_HINT };
  }

  // Refuse commands that would prompt. Measured: `bh info` with no module prints a
  // selection list and waits, so a headless caller gets a timeout for a working CLI.
  // "Prompts" and "broken" are different diagnoses and must not be conflated.
  if ((LEXICON_INTERACTIVE_ACTIONS as readonly string[]).includes(action)) {
    const flagsIn = options.flags ?? {};
    const hasTarget = 'module' in flagsIn || 'm' in flagsIn || '_' in flagsIn;
    if (!hasTarget) {
      return {
        action, exitCode: 2, stdout: '', stderr: '',
        error:
          `\`${action}\` prompts for a module when none is given, and a headless call ` +
          'cannot answer a prompt. Pass { module: "<name>" } (e.g. "Harmony").',
      };
    }
  }

  const safeFlags: Record<string, string> = {};
  for (const [name, value] of Object.entries(options.flags ?? {})) {
    const check = validateLexiconFlag(name, value);
    if (!check.ok) {
      return { action, exitCode: 2, stdout: '', stderr: '', error: check.reason };
    }
    safeFlags[name] = check.value;
  }

  return runOnce(entryPath, action, safeFlags);
}

function runOnce(
  entryPath: string,
  action: string,
  flags: Record<string, string>,
): Promise<LexiconInvocationResult> {
  return new Promise(resolve => {
    // Plain `node`: the entry is bundled JavaScript, so no TypeScript loader is needed.
    // BANNERSAGE_LEXICON_RUNNER overrides it for an unusual checkout.
    const program = process.env.BANNERSAGE_LEXICON_RUNNER ?? 'node';
    const child = spawn(
      program,
      [entryPath, action, ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])],
      {
        cwd: entryPath.slice(0, Math.max(entryPath.lastIndexOf('\\'), entryPath.lastIndexOf('/'))) || undefined,
        shell: false,
        windowsHide: true,
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      },
    );

    let stdout = '';
    let stderr = '';
    let settled = false;
    let stoppedForSize = false;

    const finish = (result: LexiconInvocationResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ action, exitCode: 2, stdout, stderr, error: `timed out after ${LEXICON_TIMEOUT_MS}ms` });
    }, LEXICON_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > LEXICON_MAX_OUTPUT_BYTES) {
        stoppedForSize = true;
        try { child.kill(); } catch { /* already gone */ }
      }
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      finish({ action, exitCode: 2, stdout, stderr, error: err.message ?? String(err) });
    });

    child.on('close', (code: number | null) => {
      if (stoppedForSize) {
        finish({
          action, exitCode: 2, stdout, stderr,
          error: `output exceeded ${LEXICON_MAX_OUTPUT_BYTES} bytes and was stopped`,
        });
        return;
      }
      finish({ action, exitCode: code ?? 2, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) });
    });
  });
}
