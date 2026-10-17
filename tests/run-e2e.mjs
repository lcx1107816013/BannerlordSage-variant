/**
 * End-to-end check that the three new capabilities work through the REAL MCP server,
 * against a corpus shaped like an actual Bannerlord install.
 *
 * WHY THIS IS DIFFERENT FROM THE EXISTING CHECKS
 * ----------------------------------------------
 * The unit checks call the tool functions directly. This one starts the MCP server the way a
 * client does, lists its tools, and invokes them over the protocol - so what is verified is the
 * whole path a user exercises: registration, schema, argument marshalling, the body, the
 * rendered report.
 *
 * A tool can pass a unit test and still be unusable because its schema rejects the argument the
 * implementation expects, or because it was never registered. That failure mode is invisible
 * from a direct function call, which is why this exists.
 *
 * THE CORPUS IS SHAPED LIKE THE REAL THING, which is also the point: `Modules/<id>/` with a
 * `SubModule.xml`, a `bin/` that must be pruned, artwork under `GUI/`, and two mods with
 * `[HarmonyPatch]` attributes competing for one method. If the walker needs a shape the corpus
 * does not have, the test fails rather than the real install being wrong.
 *
 * Usage: node tests/run-e2e.mjs   (spawns the real server, speaks MCP over stdio)
 */
import { spawnSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const MIN_PLAUSIBLE_BYTES = 1_000_000;

function plausible(p) {
  try {
    const s = statSync(p);
    return s.isFile() && s.size >= MIN_PLAUSIBLE_BYTES;
  } catch {
    return false;
  }
}

function findBun() {
  if (process.env.BUN_PATH && plausible(process.env.BUN_PATH)) return process.env.BUN_PATH;
  try {
    const out = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['bun'], { encoding: 'utf8' });
    if (out.status === 0 && out.stdout) {
      for (const line of out.stdout.split(/\r?\n/)) {
        const c = line.trim();
        if (c && plausible(c)) return c;
      }
    }
  } catch { /* not on PATH */ }
  const pkgs = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Packages') : undefined;
  if (pkgs && existsSync(pkgs)) {
    for (const e of readdirSync(pkgs)) {
      if (!e.toLowerCase().includes('bun')) continue;
      const root = join(pkgs, e);
      for (const inner of readdirSync(root)) {
        const c = join(root, inner, 'bun.exe');
        if (plausible(c)) return c;
      }
    }
  }
  console.error('no usable bun found (the WinGet shim is 0 bytes and exits silently)');
  process.exit(2);
}

const bun = findBun();
const root = mkdtempSync(join(tmpdir(), 'e2e-'));
let failures = 0;

function assert(label, cond, extra) {
  if (cond) {
    console.log(`PASS ${label}`);
  } else {
    failures++;
    console.log(`FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 400));
  }
}

function put(rel, body = 'x') {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, body);
}

// ── a corpus shaped like a real install ─────────────────────────────────────
put('Modules/Native/SubModule.xml', '<Module><Name value="Native"/></Module>');
put('Modules/Native/GUI/Textures/Banner.DDS', 'd'.repeat(64));
put('Modules/Native/GUI/Prefabs/InventoryScreen.xml', '<Prefabs><Widget DataSource="{VM}"/></Prefabs>');
put('Modules/Native/ModuleData/items.xml', '<Items><Item id="iron_sword"/></Items>');
put('Modules/Native/bin/Win64_Shipping_Client/Build.dds', 'b'.repeat(8)); // must be pruned

put('Modules/CombatMod/SubModule.xml', '<Module><Name value="CombatMod"/></Module>');
put('Modules/CombatMod/bin/Win64_Shipping_Client/Combat.dll', 'MZ');
put('Modules/CombatMod/Patches/BlockPatch.cs', [
  'using HarmonyLib;',
  '[HarmonyPatch(typeof(Mission), "OnAgentHit")]',
  '[HarmonyTranspiler]',
  'class BlockPatch { }',
].join('\n'));

put('Modules/OverhaulMod/SubModule.xml', '<Module><Name value="OverhaulMod"/></Module>');
put('Modules/OverhaulMod/Patches/OverhaulPatch.cs', [
  'using HarmonyLib;',
  '[HarmonyPatch(typeof(Mission), nameof(Mission.OnAgentHit))]',
  '[HarmonyTranspiler]',
  'class OverhaulPatch { }',
].join('\n'));

put('GUI/Textures/InstallLevel.png', 'i'.repeat(16));

// ── speak MCP to the real server ───────────────────────────────────────────
const serverPath = join(repoRoot, 'src', 'entrypoints', 'bannerlord-stdio.ts');
const child = spawn(bun, ['run', serverPath], {
  cwd: repoRoot,
  env: { ...process.env, BANNERSAGE_EULA_ACCEPTED: 'true', BANNERSAGE_TOOLSET: 'full' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', chunk => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function rpc(method, params, timeoutMs = 60_000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, msg => { clearTimeout(timer); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function callTool(name, args) {
  const msg = await rpc('tools/call', { name, arguments: args }, 90_000);
  if (msg.error) return { ok: false, text: JSON.stringify(msg.error) };
  const text = (msg.result?.content ?? []).map(c => c.text ?? '').join('\n');
  return { ok: !msg.result?.isError, text };
}

try {
  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '0' },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools ?? []).map(t => t.name);
  assert('the server advertises the new tools',
    names.includes('ba_index_assets') && names.includes('ba_find_asset') && names.includes('ba_check_mod_conflicts'),
    names.filter(n => n.startsWith('ba_')).slice(-6));

  // ── index_assets over MCP ────────────────────────────────────────────────
  const idx = await callTool('ba_index_assets', { gameDir: root });
  assert('index_assets runs over the wire', idx.ok, idx.text.slice(0, 300));
  assert('index_assets finds module artwork', idx.text.includes('Banner.DDS'), idx.text.slice(0, 400));
  assert('index_assets finds install-level artwork', idx.text.includes('InstallLevel.png'), idx.text.slice(0, 400));
  assert('index_assets prunes bin/', !idx.text.includes('Build.dds'), idx.text.slice(0, 400));
  assert('index_assets reports the module for each entry', idx.text.includes('[Native]'), idx.text.slice(0, 400));

  const scoped = await callTool('ba_index_assets', { gameDir: root, moduleId: 'CombatMod' });
  assert('moduleId scopes the walk over the wire',
    scoped.ok && !scoped.text.includes('Banner.DDS'), scoped.text.slice(0, 300));

  const badDir = await callTool('ba_index_assets', { gameDir: join(root, 'nope') });
  assert('a bad directory is reported, not reported as empty',
    badDir.text.includes('not a readable directory'), badDir.text.slice(0, 300));

  // ── find_asset over MCP ──────────────────────────────────────────────────
  const found = await callTool('ba_find_asset', { gameDir: root, query: 'banner' });
  assert('find_asset runs over the wire', found.ok, found.text.slice(0, 300));
  assert('find_asset locates the file', found.text.includes('Banner.DDS'), found.text.slice(0, 400));

  // ── check_mod_conflicts over MCP ─────────────────────────────────────────
  const conf = await callTool('ba_check_mod_conflicts', {
    modDirs: [join(root, 'Modules', 'CombatMod'), join(root, 'Modules', 'OverhaulMod')],
  });
  assert('check_mod_conflicts runs over the wire', conf.ok, conf.text.slice(0, 400));
  assert('it finds the transpiler clash between the two mods',
    conf.text.includes('transpiler_clash'), conf.text.slice(0, 500));
  assert('it names both mods',
    conf.text.includes('CombatMod') && conf.text.includes('OverhaulMod'), conf.text.slice(0, 500));
  assert('it states the static boundary',
    conf.text.includes('no game was started'), conf.text.slice(0, 600));
} finally {
  try { child.stdin.end(); } catch { /* gone */ }
  try { child.kill(); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
}

console.log('');
console.log(failures === 0 ? 'E2E_OK' : `E2E_FAILED_${failures}`);
process.exit(failures === 0 ? 0 : 1);
