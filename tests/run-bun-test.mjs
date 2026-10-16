/**
 * Run `bun test` through a resolved bun, so an npm script cannot silently do nothing.
 *
 * THE TRAP THIS EXISTS FOR: `bun` on PATH on this machine is a ZERO-BYTE WinGet shim.
 * Executing it produces no output and no error - it simply does nothing, so `npm run test`
 * hangs until the caller times out. A script written as `"test": "bun test"` therefore looks
 * correct, is correct on a normal machine, and tests NOTHING here.
 *
 * The first version of this repository's test scripts had exactly that shape, and it was
 * found the way these things are: by running the script and getting a timeout with no output
 * rather than a pass or a failure.
 *
 * Node is the launcher because Node IS reliably on PATH while bun is not. The bun path is
 * checked for plausibility (a real binary is tens of megabytes; the shim is zero bytes) and
 * the run fails loudly if none is found, rather than reporting success for work not done.
 *
 * Usage: node tests/run-bun-test.mjs [-- extra bun test args]
 */
import { spawnSync } from 'node:child_process';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

/** A bun below this size cannot be the real binary; the WinGet shim is 0 bytes. */
const MIN_PLAUSIBLE_BYTES = 1_000_000;

function plausible(candidate) {
  try {
    const stats = statSync(candidate);
    return stats.isFile() && stats.size >= MIN_PLAUSIBLE_BYTES;
  } catch {
    return false;
  }
}

function findBun() {
  const tried = [];

  if (process.env.BUN_PATH) {
    tried.push(['BUN_PATH', process.env.BUN_PATH]);
    if (plausible(process.env.BUN_PATH)) return process.env.BUN_PATH;
  }

  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const out = spawnSync(which, ['bun'], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      for (const line of out.stdout.split(/\r?\n/)) {
        const candidate = line.trim();
        if (!candidate) continue;
        tried.push(['PATH', candidate]);
        if (plausible(candidate)) return candidate;
      }
    }
  } catch {
    /* not on PATH */
  }

  const packages = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages')
    : undefined;
  if (packages && existsSync(packages)) {
    try {
      for (const entry of readdirSync(packages)) {
        if (!entry.toLowerCase().includes('bun')) continue;
        const root = join(packages, entry);
        for (const inner of readdirSync(root)) {
          const candidate = join(root, inner, 'bun.exe');
          tried.push(['WinGet package dir', candidate]);
          if (plausible(candidate)) return candidate;
        }
      }
    } catch {
      /* unreadable */
    }
  }

  console.error('No usable bun found. A 0-byte WinGet shim resolves as "bun" here and exits');
  console.error('silently, so `bun test` would appear to run and test nothing. Tried:');
  for (const [label, value] of tried) console.error(`  ${label}: ${value}`);
  console.error('Set BUN_PATH to a real executable.');
  process.exit(2);
}

const bun = findBun();
const extra = process.argv.slice(2).filter(a => a !== '--');

const result = spawnSync(bun, ['test', ...extra], {
  cwd: repoRoot,
  stdio: 'inherit',
  encoding: 'utf8',
});

if (result.error) {
  console.error(`failed to launch bun test: ${result.error.message}`);
  process.exit(2);
}
process.exit(result.status ?? 1);
