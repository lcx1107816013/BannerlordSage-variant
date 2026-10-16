/**
 * Run the standalone check scripts, with no reliance on the shell's `bun`.
 *
 * WHY A RUNNER, AND WHY THE SCRIPTS ARE SEPARATE FROM `bun test`
 * -------------------------------------------------------------
 * Two conventions were sharing one directory and corrupting each other's output:
 *
 *   tests/*.test.ts          bun test files, which report through bun's own harness
 *   tests/checks/*.check.ts  standalone scripts that assert and call process.exit
 *
 * `bun test` treats ANY `*.test.ts` as its own, so having the standalone scripts match that
 * pattern meant `bun test` loaded them, ran them as ordinary modules, and had its summary
 * buried under their PASS lines - while their `process.exit` calls ended the process early.
 * Separating the directories fixes the discovery; this runner is how the standalone ones are
 * invoked.
 *
 * WHY NOT A BARE `bun` IN THE SCRIPT: on this machine `bun` on PATH is a zero-byte WinGet
 * shim that exits silently, so the suites appear to run and test nothing. The runner resolves
 * a plausibility-checked bun and treats "exit 0 with NO OUTPUT" as a failure, because that is
 * exactly the shim's signature.
 *
 * Usage:
 *   node tests/run-checks.mjs                # every check
 *   node tests/run-checks.mjs conflicts      # one, by name fragment
 */
import { spawnSync } from 'node:child_process';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

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
  console.error('silently, so a bare `bun` cannot be trusted. Tried:');
  for (const [label, value] of tried) console.error(`  ${label}: ${value}`);
  console.error('Set BUN_PATH to a real executable.');
  process.exit(2);
}

const bun = findBun();
const checksDir = join(here, 'checks');
const all = readdirSync(checksDir).filter(f => f.endsWith('.check.ts')).sort();
const filter = process.argv[2];
const selected = filter ? all.filter(f => f.includes(filter)) : all;

if (selected.length === 0) {
  console.error(`no check matches ${JSON.stringify(filter)}; known: ${all.join(', ')}`);
  process.exit(2);
}

let failed = 0;
for (const file of selected) {
  const label = file.replace('.check.ts', '').padEnd(16);
  const result = spawnSync(bun, [join('tests', 'checks', file)], { cwd: repoRoot, encoding: 'utf8' });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const ok = result.status === 0;

  // Silence with a zero exit is the shim's signature, so it counts as a failure here even
  // though the exit code looks fine.
  const silent = output.trim().length === 0;
  const lastLine = output.trim().split(/\r?\n/).filter(Boolean).pop() ?? '(no output)';

  if (ok && !silent) {
    console.log(`  [ok]   ${label} ${lastLine}`);
  } else if (ok && silent) {
    failed++;
    console.log(`  [!!]   ${label} exit 0 but produced NO OUTPUT - treated as a failure`);
  } else {
    failed++;
    console.log(`  [!!]   ${label} exit ${result.status}`);
    console.log(output.split(/\r?\n/).slice(-10).map(l => `           ${l}`).join('\n'));
  }
}

console.log('');
console.log(failed === 0 ? 'CHECKS_OK' : `CHECKS_FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
