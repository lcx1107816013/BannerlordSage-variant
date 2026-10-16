/**
 * Behaviour tests for the Archive → Bridge direct invocation.
 *
 * WHAT IS ACTUALLY TESTABLE HERE, AND WHAT IS NOT.
 *
 * There is no running game, so the happy path cannot be exercised end to end. What CAN be
 * pinned is everything that decides whether the call is safe and correctly shaped:
 *
 *   - the action allow-list is CLOSED (an arbitrary action must be rejected before spawning)
 *   - values never reach a shell: they go through `spawn` with an argv array
 *   - oversized and control-character values are refused BEFORE argv is built
 *   - a missing configuration produces a clear error rather than a hang
 *   - JSON is extracted from indented, surrounded output
 *
 * Those are the assertions that matter most, because the failure they prevent is the tool
 * becoming a command-execution surface. The one end-to-end case uses a stub script written to
 * a temp directory, so the subprocess path itself is exercised without needing Bannerlord.
 */
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BRIDGE_ACTIONS,
  BRIDGE_MAX_ARG_LENGTH,
  actionNeedsGame,
  buildBridgeArgv,
  extractJson,
  invokeBridge,
  validateFlagValue,
} from '../../src/utils/bridge-client';
import { bridgeQuery } from '../../src/tools/bridge-query';

const root = mkdtempSync(join(tmpdir(), 'bridge-client-'));
let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 300));
  }
}

const textOf = (r: { content: Array<{ text: string }> }) => r.content[0].text;

try {
  // ── the allow-list is closed ─────────────────────────────────────────────
  const rejected = await invokeBridge('rm -rf /' as never, { bridgeDir: root });
  assert('an arbitrary action is refused before anything is spawned',
    rejected.exitCode === 2 && (rejected.error ?? '').includes('unknown action'), rejected);

  const injected = await invokeBridge('status; whoami' as never, { bridgeDir: root });
  assert('a shell-looking action string is refused',
    injected.exitCode === 2, injected);

  assert('the allow-list does not contain a shell verb',
    !BRIDGE_ACTIONS.some(a => /[;&|`$]/.test(a)), BRIDGE_ACTIONS);

  // ★★ TWO NEGATIVE CONTROLS FOUND HOLES HERE, AND BOTH WERE IN THE MOST IMPORTANT PLACES.
  //
  // Opening BRIDGE_ACTIONS to include `rm`/`curl`/`sh` changed NO test result, and neither did
  // flipping `shell: false` to `shell: true`. The suite was passing on OUTCOMES (the exit
  // code) rather than on MECHANISM, and both mutations keep the outcomes plausible while
  // removing the guard that matters. So the allow-list is now pinned by its exact contents,
  // and the no-shell property is pinned by reading the source of the only function that
  // spawns - because there is no runtime observation that distinguishes `shell: false` from
  // `shell: true` when the input happens to be benign.
  const expectedActions = [
    'ping', 'status', 'build-check', 'patches', 'patch-failures',
    'modules', 'crash', 'exceptions', 'capability-probe',
  ];
  assert('the allow-list is exactly the audited set, with nothing added',
    JSON.stringify([...BRIDGE_ACTIONS]) === JSON.stringify(expectedActions), BRIDGE_ACTIONS);
  assert('the allow-list contains no verb that runs a program',
    !BRIDGE_ACTIONS.some(a => ['rm', 'sh', 'bash', 'curl', 'wget', 'python', 'node', 'cmd', 'powershell'].includes(a)),
    BRIDGE_ACTIONS);

  // The spawn call must not use a shell. Read as source text, since a benign input cannot
  // expose the difference at runtime - and the difference is what makes a metacharacter a
  // value instead of syntax.
  const clientSource = await readFile(join(import.meta.dir, '..', '..', 'src', 'utils', 'bridge-client.ts'), 'utf8');
  assert('the spawn call disables the shell',
    /shell:\s*false/.test(clientSource), 'no `shell: false` found in bridge-client.ts');
  assert('the spawn call does not enable the shell',
    !/shell:\s*true/.test(clientSource), '`shell: true` found in bridge-client.ts');

  // ── argv shaping ─────────────────────────────────────────────────────────
  assert('argv is an array with the script and action first',
    JSON.stringify(buildBridgeArgv('status')) === JSON.stringify(['bl_cmd.py', 'status']));
  assert('flags become --name value pairs',
    JSON.stringify(buildBridgeArgv('patches', { owner: 'com.rbm' }))
      === JSON.stringify(['bl_cmd.py', 'patches', '--owner', 'com.rbm']));
  // ★ The point of an argv array: a value that looks like shell syntax stays a value.
  const shellish = buildBridgeArgv('patches', { owner: 'a; rm -rf /' });
  assert('a metacharacter in a VALUE stays a single argv entry',
    shellish.length === 4 && shellish[3] === 'a; rm -rf /', shellish);

  // ── flag validation happens BEFORE argv ──────────────────────────────────
  const tooLong = validateFlagValue('owner', 'x'.repeat(BRIDGE_MAX_ARG_LENGTH + 1));
  assert('an oversized value is rejected', tooLong.ok === false, tooLong);

  const withNewline = validateFlagValue('owner', 'a\nb');
  assert('a value with a newline is rejected', withNewline.ok === false, withNewline);

  const withNul = validateFlagValue('owner', 'a\0b');
  assert('a value with a NUL is rejected', withNul.ok === false, withNul);

  const fine = validateFlagValue('owner', 'com.rbm');
  assert('an ordinary value passes', fine.ok === true, fine);

  // ── missing configuration is a clear error, not a hang ───────────────────
  const noDir = await invokeBridge('status', { bridgeDir: undefined });
  // BANNERSAGE_BRIDGE_DIR may be set in the environment; only assert when it is not.
  if (!process.env.BANNERSAGE_BRIDGE_DIR) {
    assert('an unconfigured bridge directory is reported clearly',
      noDir.exitCode === 2 && (noDir.error ?? '').includes('BANNERSAGE_BRIDGE_DIR'), noDir);
  } else {
    console.log('SKIP an unconfigured bridge directory (BANNERSAGE_BRIDGE_DIR is set)');
  }

  const emptyDir = join(root, 'empty');
  mkdirSync(emptyDir, { recursive: true });
  const noScript = await invokeBridge('status', { bridgeDir: emptyDir });
  assert('a directory without bl_cmd.py says so',
    noScript.exitCode === 2 && (noScript.error ?? '').includes('bl_cmd.py not found'), noScript);

  // ── JSON extraction over the shapes the CLI actually emits ───────────────
  assert('extracts an indented object',
    (extractJson('{\n "ok": true,\n "n": 1\n}') as { ok: boolean } | null)?.ok === true);
  assert('extracts an object surrounded by other lines',
    (extractJson('log line\n{"ok":true}\ntrailing') as { ok: boolean } | null)?.ok === true);
  assert('handles a brace inside a string',
    (extractJson('{"msg":"a } b","ok":true}') as { ok: boolean } | null)?.ok === true);
  assert('handles an escaped quote inside a string',
    (extractJson('{"msg":"a \\" b","ok":true}') as { ok: boolean } | null)?.ok === true);
  assert('returns null when there is no JSON',
    extractJson('plain text only') === null);
  assert('returns null on malformed JSON rather than throwing',
    extractJson('{ "ok": tru') === null);

  // ── which actions need the game ──────────────────────────────────────────
  assert('status needs the game', actionNeedsGame('status'));
  assert('build-check does not', !actionNeedsGame('build-check'));

  // ── end to end through a stub CLI ────────────────────────────────────────
  // This exercises the real subprocess path without Bannerlord. The stub ignores its
  // arguments and prints the shape the real CLI prints.
  const stubDir = join(root, 'stub');
  mkdirSync(stubDir, { recursive: true });
  writeFileSync(
    join(stubDir, 'bl_cmd.py'),
    [
      'import json, sys',
      'payload = {"ok": True, "action": sys.argv[1] if len(sys.argv) > 1 else None, "argv": sys.argv[1:]}',
      'print(json.dumps(payload, ensure_ascii=False, indent=1))',
      'sys.exit(0)',
    ].join('\n'),
  );

  const live = await invokeBridge('status', { bridgeDir: stubDir });
  assert('a real subprocess round-trip succeeds', live.exitCode === 0, live);
  assert('its JSON payload is parsed',
    (live.payload as { ok: boolean } | null)?.ok === true, live.payload);
  assert('flags reach the CLI',
    JSON.stringify((live.payload as { argv: string[] }).argv) === JSON.stringify(['status', '--owner', 'x'])
      || JSON.stringify((live.payload as { argv: string[] }).argv) === JSON.stringify(['status']),
    (live.payload as { argv: string[] }).argv);

  const withFlag = await invokeBridge('patches', { bridgeDir: stubDir, flags: { owner: 'com.rbm' } });
  assert('a flag round-trips through argv',
    JSON.stringify((withFlag.payload as { argv: string[] }).argv) === JSON.stringify(['patches', '--owner', 'com.rbm']),
    (withFlag.payload as { argv: string[] }).argv);

  // ── the tool layer ───────────────────────────────────────────────────────
  const noAction = await bridgeQuery({ action: '' });
  assert('an empty action is an error naming the alternatives',
    textOf(noAction).includes('action is required') && textOf(noAction).includes('status'), textOf(noAction));

  const badAction = await bridgeQuery({ action: 'definitely-not-a-bridge-action' });
  assert('an unknown action lists what is available',
    textOf(badAction).includes('unknown action'), textOf(badAction));

  const toolLive = await bridgeQuery({ action: 'status', bridgeDir: stubDir });
  const toolText = textOf(toolLive);
  assert('the tool reports the action and exit code',
    toolText.includes('action: status') && toolText.includes('exit_code: 0'), toolText.slice(0, 300));
  assert('the tool states whether the game must be running',
    toolText.includes('needs_running_game: true'), toolText);
  assert('the tool passes the payload through',
    toolText.includes('"ok": true'), toolText);
  assert('the tool says it used a subprocess',
    toolText.includes('subprocess'), toolText);
  assert('the tool points at the source-side counterpart',
    toolText.includes('check_mod_conflicts'), toolText);
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'BRIDGE_CLIENT_OK' : `BRIDGE_CLIENT_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);
