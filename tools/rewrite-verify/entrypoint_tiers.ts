/**
 * Verify an entrypoint selects the same tool tier as the upstream revision.
 *
 * WHY THIS EXISTS
 * ---------------
 * The two entrypoints were never covered by any test: no fixture imports them, and
 * `tools/list` is the only thing that reveals which tier they pick. So a rewrite of them
 * has no judgement to fail against — and the tier is exactly what they control.
 *
 * The trap this is built to catch, found while rewriting `bannerlord-stdio.ts`:
 * `||=` and `??=` are NOT interchangeable here. The toolset resolver treats anything
 * that is not exactly `query-first` as `full`, so with `BANNERSAGE_TOOLSET=""`:
 *
 *     ||=  -> 'query-first'  ->  the resolver sees query-first  ->  query-first tier
 *     ??=  -> ""             ->  the resolver falls back to full ->  full tier
 *
 * A draft used `??=` ("the nullish form is the safer default") and this measurement is
 * what caught it. An entry-point smoke run that only checks "it printed the ready line"
 * would have missed it, because both spellings start up fine.
 *
 * Usage:
 *   <bundled-bun> tools/rewrite-verify/entrypoint_tiers.ts
 *
 * Output is a table of (entrypoint, BANNERSAGE_TOOLSET) -> tool count. Run it against the
 * upstream revision by checking that file out to a scratch tree and pointing SAGE_ROOT
 * at it; the expected counts by tier live in TIERS below.
 *
 * ★ THE COUNTS MOVED WHEN THE ASSET TOOLS WERE ADDED. They were 39/46 and are now 41/48,
 * because index_assets and find_asset joined the query-first tier. The size that matters is
 * TIERS, and a test that reads it is why the addition was noticed here at all - a hardcoded
 * expectation somewhere else would have failed with a message about the wrong thing.
 */
import { spawn } from 'node:child_process';

const SAGE_ROOT = process.env.SAGE_ROOT ?? 'D:\\GitHub\\BannerlordSage-variant';
const BUN = process.env.BUN_PATH
  ?? 'C:\\Users\\LCGX\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\\bun-windows-x64\\bun.exe';

const TIERS = { 'query-first': 41, full: 48 } as const;

type Result = { entry: string; env: string; tools: number | null; verdict: string };

/** Starts an entrypoint, asks for tools/list, returns the tool count. */
function countTools(entry: string, tooldset: string | undefined): Promise<number | null> {
  return new Promise(resolve => {
    const env = { ...process.env, BANNERSAGE_EULA_ACCEPTED: 'true' };
    if (tooldset === undefined) {
      delete env.BANNERSAGE_TOOLSET;
    } else {
      env.BANNERSAGE_TOOLSET = tooldset;
    }

    const proc = spawn(BUN, ['run', entry], { cwd: SAGE_ROOT, env, stdio: ['pipe', 'pipe', 'ignore'] });

    let buffer = '';
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { proc.kill(); } catch { /* already gone */ }
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 25000);

    proc.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id === 2) {
            finish(Array.isArray(msg?.result?.tools) ? msg.result.tools.length : null);
            return;
          }
        } catch { /* non-json line */ }
      }
    });

    proc.stdin.write(
      [
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"tier","version":"0"}}}',
        '{"jsonrpc":"2.0","method":"notifications/initialized"}',
        '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
        '',
      ].join('\n'),
    );
  });
}

const cases: Array<{ entry: string; env: string | undefined; expect: number }> = [
  { entry: 'src/entrypoints/bannerlord-stdio.ts', env: undefined, expect: TIERS['query-first'] },
  { entry: 'src/entrypoints/bannerlord-stdio.ts', env: '', expect: TIERS['query-first'] },
  { entry: 'src/entrypoints/bannerlord-stdio.ts', env: 'query-first', expect: TIERS['query-first'] },
  { entry: 'src/entrypoints/bannerlord-stdio.ts', env: 'full', expect: TIERS.full },
  // The full entrypoint FORCES full, so an empty value must not demote it.
  { entry: 'src/entrypoints/bannerlord-full-stdio.ts', env: undefined, expect: TIERS.full },
  { entry: 'src/entrypoints/bannerlord-full-stdio.ts', env: '', expect: TIERS.full },
];

const results: Result[] = [];
for (const c of cases) {
  const tools = await countTools(c.entry, c.env);
  results.push({
    entry: c.entry.replace('src/entrypoints/', ''),
    env: c.env === undefined ? '<unset>' : JSON.stringify(c.env),
    tools,
    verdict: tools === c.expect ? 'ok' : `MISMATCH (want ${c.expect})`,
  });
}

const width = Math.max(...results.map(r => r.entry.length));
for (const r of results) {
  console.log(
    `${r.entry.padEnd(width)}  BANNERSAGE_TOOLSET=${r.env.padEnd(13)} -> ${String(r.tools).padStart(2)} tools  ${r.verdict}`,
  );
}

const bad = results.filter(r => r.verdict !== 'ok').length;
console.log('');
console.log(bad === 0 ? 'ENTRYPOINT_TIERS_OK' : `ENTRYPOINT_TIERS_FAILED (${bad})`);
process.exit(bad === 0 ? 0 : 1);
