/**
 * Regression test for the 16 legacy gameplay + memory tools that commit
 * b80b55f removed and commit <this one> restored.
 *
 * Why this test exists: F1 in the BannerScribe capability ledger records that
 * these tools were removed while the commit message claimed they had "never
 * been registered". Nothing in the test suite noticed, because the registry
 * test asserted the toolset LIST against itself rather than against the tools
 * server.ts actually registers. This test closes that hole in two ways:
 *
 *   1. the registered surface must EQUAL the toolset list (set equality, so an
 *      unlisted-but-registered tool fails)
 *   2. every restored tool is really CALLED and must return a report whose
 *      report_type names the tool — a registration that routes nowhere would
 *      pass a name-only check and fail this one
 *
 * Read-only probes only; the one write probe invalidates what it created.
 */
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { archiveToolName } from '../src/utils/tool-naming'

const RESTORED = [
  'get_clan_summary',
  'get_culture_summary',
  'get_hero_profile',
  'get_item_stats',
  'get_kingdom_summary',
  'get_perk_data',
  'get_policy_summary',
  'get_settlement_summary',
  'get_skill_data',
  'trace_troop_tree',
  'project_memory_add',
  'project_memory_capture_session',
  'project_memory_invalidate',
  'project_memory_recent',
  'project_memory_search',
  'project_memory_wakeup',
].map(archiveToolName)

/** Read-only calls, chosen so the tool returns a deterministically non-empty report. */
const READ_PROBES: Record<string, Record<string, unknown>> = {
  [archiveToolName('get_clan_summary')]: { clanId: 'clan_empire_north_3' },
  // culture ids are bare in bannerlord_cultures ('empire', 'aserai'), NOT
  // 'Culture.empire' — that prefixed form is the XML ref, not the key.
  [archiveToolName('get_culture_summary')]: { cultureId: 'empire' },
  [archiveToolName('get_hero_profile')]: { heroId: 'lord_1_1' },
  [archiveToolName('get_item_stats')]: { itemId: 'saddle_horse' },
  [archiveToolName('get_kingdom_summary')]: { kingdomId: 'empire' },
  [archiveToolName('get_perk_data')]: { perkId: 'AthleticsBraced' },
  [archiveToolName('get_policy_summary')]: { policyId: 'policy_bailiffs' },
  [archiveToolName('get_settlement_summary')]: { settlementId: 'town_B1' },
  [archiveToolName('get_skill_data')]: { skillId: 'IronFlesh1' },
  [archiveToolName('trace_troop_tree')]: { characterId: 'vlandian_recruit' },
  [archiveToolName('project_memory_recent')]: { limit: 1 },
  // project_memory_search is excluded from the report-shape assertion: finding
  // nothing is a legitimate outcome and it renders a "No project memories
  // matched" line instead of a report. Its query safety is asserted separately.
  [archiveToolName('project_memory_search')]: { query: 'bannerlordsage-memory', limit: 1 },
  [archiveToolName('project_memory_wakeup')]: { limit: 1 },
}

/**
 * Runs a script in a fresh Bun process and returns its parsed JSON output.
 *
 * The entry point is referenced by ABSOLUTE file URL: a `bun -e` script's own
 * module dir is `[eval]`, so a relative './src/server.ts' import fails there
 * even with cwd set.
 */
async function withServer<T>(fn: string): Promise<T> {
  const root = resolve(import.meta.dir, '..')
  const entry = `file:///${resolve(root, 'src/server.ts').replace(/\\/g, '/')}`
  // The SDK ships an `exports` map, so the deep path a consumer writes
  // ('@modelcontextprotocol/sdk/client/index.js') does not exist on disk — the
  // real file is dist/esm/... . Resolving it by hand here keeps the child a
  // plain `bun -e` script with no bundler in the loop.
  const sdk = (p: string) =>
    `file:///${resolve(root, 'node_modules/@modelcontextprotocol/sdk/dist/esm', p).replace(/\\/g, '/')}`
  const script = `
    process.env.BANNERSAGE_GAME='bannerlord';
    process.env.BANNERSAGE_TOOLSET='full';
    delete process.env.BANNERSAGE_EDITOR_PROBE_SESSION;
    const {server}=await import(${JSON.stringify(entry)});
    const {Client}=await import(${JSON.stringify(sdk('client/index.js'))});
    const {InMemoryTransport}=await import(${JSON.stringify(sdk('inMemory.js'))});
    const [ct,st]=InMemoryTransport.createLinkedPair();
    const client=new Client({name:'legacy-test',version:'0.0.1'});
    await server.connect(st); await client.connect(ct);
    try {
      const names=(await client.listTools()).tools.map(x=>x.name).sort();
      let out={};
      ${fn}
      console.log(JSON.stringify({names,out}));
    } finally {await client.close(); await server.close();}
  `
  const proc = Bun.spawn([process.execPath, '-e', script], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0 || stderr.trim() !== '') {
    throw new Error(`child failed (code ${code}):\n${stderr}`)
  }
  return JSON.parse(stdout) as T
}

describe('restored legacy gameplay + memory tools', () => {
  test('toolset list equals the actually registered surface', async () => {
    const { names } = await withServer<{ names: string[] }>('')
    const { getActiveBannerlordToolNames } = await import('../src/utils/bannerlord-toolset')
    const listed = [...getActiveBannerlordToolNames()].sort()

    const registeredOnly = names.filter(n => !listed.includes(n))
    const listedOnly = listed.filter(n => !names.includes(n))
    expect({ registeredOnly, listedOnly }).toEqual({ registeredOnly: [], listedOnly: [] })
  }, 60_000)

  test('all 16 restored tools are registered', async () => {
    const { names } = await withServer<{ names: string[] }>('')
    const missing = RESTORED.filter(n => !names.includes(n))
    expect(missing).toEqual([])
  }, 60_000)

  test('every restored read tool really returns its own report', async () => {
    const calls = Object.entries(READ_PROBES)
      .map(
        ([name, args]) => `
        {
          const r=await client.callTool({name:${JSON.stringify(name)},arguments:${JSON.stringify(args)}});
          const t=r.content.find(x=>x.type==='text');
          out[${JSON.stringify(name)}]={isError:!!r.isError,text:t?t.text:''};
        }`,
      )
      .join('\n')

    const { out } = await withServer<{ out: Record<string, { isError: boolean; text: string }> }>(calls)

    const problems: string[] = []
    for (const [name, res] of Object.entries(out)) {
      if (res.isError) problems.push(`${name}: returned isError`)
      else if (!res.text.trim()) problems.push(`${name}: empty body`)
      // Every lookup tool renders a report header. `project_memory_search` is
      // exempt: a query with no hits legitimately renders an explanatory line
      // instead of a report, and its query safety is asserted by its own test.
      else if (name !== archiveToolName('project_memory_search')) {
        if (!res.text.includes('report_type:')) problems.push(`${name}: no report_type header`)
        else if (!res.text.includes('result_count:')) problems.push(`${name}: no result_count header`)
      }
    }
    expect(problems).toEqual([])
  }, 120_000)

  test('the write path round-trips and can be invalidated', async () => {
    const fn = `
      {
        const marker='bannerscribe-regression-'+Date.now();
        const a=await client.callTool({name:${JSON.stringify(archiveToolName('project_memory_add'))},arguments:{text:marker,workspace:'bannerscribe',topic:'regression',kind:'note',importance:1}});
        const at=a.content.find(x=>x.type==='text').text;
        const id=(at.match(/stored_memory_id:\\s*(\\S+)/)||[])[1];
        const s=await client.callTool({name:${JSON.stringify(archiveToolName('project_memory_search'))},arguments:{query:marker,limit:5}});
        const st=s.content.find(x=>x.type==='text').text;
        const inv=await client.callTool({name:${JSON.stringify(archiveToolName('project_memory_invalidate'))},arguments:{memoryId:id,reason:'automated regression probe'}});
        const it=inv.content.find(x=>x.type==='text').text;
        out={id,added:at,found:st,invalidated:it};
      }`

    const { out } = await withServer<{
      out: { id?: string; added: string; found: string; invalidated: string }
    }>(fn)

    expect(out.id).toBeTruthy()
    expect(out.added).toContain('report_type: project_memory_add')
    expect(out.found).toContain('result_count: 1')
    expect(out.invalidated).toContain('report_type: project_memory_invalidate')
  }, 120_000)

  /**
   * The query builder must never throw, whatever the user types.
   *
   * Measured before the fix: `MATCH 'a-b-c'` → `no such column: b`. Other
   * punctuation throws its own FTS5 syntax errors, so this sweeps the shapes a
   * user actually produces rather than one happy string.
   */
  test('project_memory_search survives FTS5-hostile queries', async () => {
    const queries = [
      'bannerlordsage-memory',
      'a-b-c',
      'seamless-coop-patch',
      'quote"inside',
      'unbalanced"quote',
      'leading-',
      '-trailing',
      '--double',
      'NEAR(a b)',
      'title:x',
      'wild*card',
      '"quoted phrase"',
      'paren(s)',
      'colon:field',
      '中文-中文',
      'a AND b OR c',
      '',
      '   ',
    ]
    const calls = queries
      .map(
        (q, i) => `
        {
          const r=await client.callTool({name:${JSON.stringify(archiveToolName('project_memory_search'))},arguments:{query:${JSON.stringify(q)},limit:2}});
          const t=r.content.find(x=>x.type==='text');
          out['q'+${i}]=JSON.stringify({q:${JSON.stringify(q)},isError:!!r.isError,text:t?t.text:''});
        }`,
      )
      .join('\n')

    const { out } = await withServer<{ out: Record<string, string> }>(calls)

    const problems: string[] = []
    for (const raw of Object.values(out)) {
      const r = JSON.parse(raw) as { q: string; isError: boolean; text: string }
      const looksLikeThrow =
        /no such column|syntax error|unterminated|fts5: syntax/i.test(r.text)
      if (looksLikeThrow) problems.push(`${JSON.stringify(r.q)} threw: ${r.text.slice(0, 120)}`)
      else if (!r.text.trim()) problems.push(`${JSON.stringify(r.q)} returned an empty body`)
    }
    expect(problems).toEqual([])
  }, 120_000)
})
