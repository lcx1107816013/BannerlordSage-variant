/**
 * Archive -> Lexicon: the last missing edge in the toolchain.
 *
 * WHAT IS BEING VERIFIED
 * ----------------------
 * Not "the tool is registered" -- a registration that cannot answer is exactly the
 * failure this project keeps finding. What matters:
 *
 *   1. `lexicon_query` validates its action against a CLOSED list. An unknown action
 *      must be refused before any process is spawned.
 *   2. flag values are length-capped and control characters rejected, because argv is
 *      an OS boundary and a newline does not survive it intact.
 *   3. `info` without a module is REFUSED with an explanation. Measured: `bh info`
 *      prints a selection prompt and waits, so a headless call would report a timeout
 *      for a CLI that works. "Prompts" and "broken" are different diagnoses.
 *   4. when the Lexicon checkout is present, `language` actually returns the supported
 *      language table, and the ANSI colour codes are gone.
 *
 * THE ANSI POINT IS NOT COSMETIC: `bh language` renders a chalk table, so its raw
 * stdout is mostly escape sequences. Forwarding them wastes tokens and makes the data
 * harder to read than the data itself.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  LEXICON_ACTIONS,
  LEXICON_MAX_ARG_LENGTH,
  buildLexiconArgv,
  invokeLexicon,
  stripAnsi,
  validateLexiconFlag,
} from '../../src/utils/lexicon-client';

let failures = 0;

function assert(label: string, condition: boolean, extra?: unknown): void {
  if (condition) {
    console.log(`PASS ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label}${extra === undefined ? '' : ` — ${JSON.stringify(extra)}`}`);
  }
}

const LEXICON_DIR = process.env.BANNERSAGE_LEXICON_DIR ?? 'D:\\GitHub\\Bannerlord-Helper-variant';

async function main(): Promise<void> {
  // ── 1. closed action list ──────────────────────────────────────────────
  assert('actions are the CLI\'s own subcommands',
    LEXICON_ACTIONS.includes('language') && LEXICON_ACTIONS.includes('info'),
    [...LEXICON_ACTIONS]);

  const bogus = await invokeLexicon('package', { lexiconDir: LEXICON_DIR });
  assert('write command `package` is refused', bogus.exitCode === 2 && /unknown action/.test(bogus.error ?? ''),
    bogus);

  const bogus2 = await invokeLexicon('rm -rf /', { lexiconDir: LEXICON_DIR });
  assert('shell-looking action is refused', bogus2.exitCode === 2, bogus2);

  // ── 2. flag validation ─────────────────────────────────────────────────
  const long = validateLexiconFlag('module', 'x'.repeat(LEXICON_MAX_ARG_LENGTH + 1));
  assert('oversized value rejected', long.ok === false, long);

  const ctrl = validateLexiconFlag('module', 'a\nb');
  assert('newline in value rejected', ctrl.ok === false, ctrl);

  const okFlag = validateLexiconFlag('module', 'Harmony');
  assert('normal value accepted', okFlag.ok === true, okFlag);

  // ── 3. argv shape: array, never a shell string ─────────────────────────
  const argv = buildLexiconArgv('language', 'entry.ts', { module: 'a b; rm -rf /' });
  assert('argv is an array', Array.isArray(argv));
  assert('metacharacters stay inside one argv element',
    argv.includes('a b; rm -rf /'), argv);

  // ── 4. `info` without a module must be refused, not left to hang ───────
  const promptless = await invokeLexicon('info', { lexiconDir: LEXICON_DIR });
  assert('info without module is refused with a reason',
    promptless.exitCode === 2 && /prompts for a module/.test(promptless.error ?? ''),
    promptless.error);

  // ── 5. ANSI stripping ──────────────────────────────────────────────────
  assert('SGR sequences removed',
    stripAnsi('\u001B[90m│\u001B[39m EN \u001B[31mEnglish\u001B[39m') === '│ EN English');
  assert('plain text untouched', stripAnsi('plain') === 'plain');

  // ── 6. live call, when the BUILT bundle is there ───────────────────────
  //
  // The bundle, not the source: Lexicon is ESM with directory imports, so the source
  // tree is not runnable by Node at all. `npm run dev` fails the same way. If dist/ is
  // absent the tool reports "run npm run build" instead of pretending the module broke.
  const entry = join(LEXICON_DIR, 'dist', 'bannerlord-helper.js');
  if (!existsSync(entry)) {
    const missing = await invokeLexicon('language', { lexiconDir: LEXICON_DIR });
    assert('unbuilt Lexicon reports a build hint, not a crash',
      missing.exitCode === 2 && /npm run build/.test(missing.error ?? ''),
      missing.error);
    console.log(`  (no build at ${entry}; live assertions skipped)`);
  } else {
    const live = await invokeLexicon('language', { lexiconDir: LEXICON_DIR });
    assert('`language` exits 0', live.exitCode === 0, live.error ?? live.stderr.slice(0, 160));
    assert('`language` returns the language table', /language code/i.test(live.stdout),
      live.stdout.slice(0, 120));
    assert('`language` output has no ANSI escapes', !/\u001B\[/.test(live.stdout),
      'escape codes leaked through');
    assert('`language` mentions EN', /\bEN\b/.test(live.stdout));
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('all assertions passed');
}

main().catch(error => {
  console.error('lexicon-client check crashed:', error);
  process.exit(1);
});
