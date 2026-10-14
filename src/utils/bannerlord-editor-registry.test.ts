import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { QUERY_FIRST_BANNERLORD_TOOL_NAMES, AUTHORING_BANNERLORD_TOOL_NAMES } from './bannerlord-toolset'

describe('editor integration into the variant BannerlordSage server', () => {
  for (const mode of ['query-first', 'full'] as const) {
    test(`${mode} registers exactly the toolset lists (incl. editor preview)`, async () => {
      // server.ts freezes mode on import. Separate processes exercise both real registries.
      const script = `
        process.env.BANNERSAGE_GAME='bannerlord';
        process.env.BANNERSAGE_TOOLSET='${mode}';
        delete process.env.BANNERSAGE_EDITOR_PROBE_SESSION;
        const {server}=await import('./src/server.ts');
        const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
        const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
        const [ct,st]=InMemoryTransport.createLinkedPair();
        const client=new Client({name:'registry-test',version:'0.0.1'});
        await server.connect(st); await client.connect(ct);
        try {
          const names=(await client.listTools()).tools.map(x=>x.name).sort();
          const result=await client.callTool({name:'bannerlord_editor_status',arguments:{}});
          const text=result.content.find(x=>x.type==='text');
          console.log(JSON.stringify({names,status:JSON.parse(text.text)}));
        } finally {await client.close(); await server.close();}
      `
      const proc = Bun.spawn([process.execPath, '-e', script], {
        cwd: resolve(import.meta.dir, '../..'),
        stdout: 'pipe', stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ])
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
      const result = JSON.parse(stdout)
      const expected = [...QUERY_FIRST_BANNERLORD_TOOL_NAMES, ...(mode === 'full' ? AUTHORING_BANNERLORD_TOOL_NAMES : [])].sort()
      expect(result.names).toEqual(expected)
      expect(new Set(result.names).size).toBe(result.names.length)
      // Counts are DERIVED from the toolset lists, never hardcoded.
      //
      // Hardcoded counts were the root cause of finding F1 in the BannerScribe
      // capability ledger: the literal "30" here was not just stale, it was
      // unmaintainable, and it still passed because the assertion above compares
      // the list against ITSELF. This repo has no tsconfig/typecheck step, so the
      // only thing that compares the list against the actually registered surface
      // is tests/legacy-tools.test.ts. Do not re-introduce a magic number here.
      const expectedCount = QUERY_FIRST_BANNERLORD_TOOL_NAMES.length + (mode === 'full' ? AUTHORING_BANNERLORD_TOOL_NAMES.length : 0)
      expect(result.names.length).toBe(expectedCount)
      expect(result.names.filter((name: string) => name.startsWith('bannerlord_editor_')).length).toBe(mode === 'full' ? 6 : 1)
      expect(result.status.state).toBe('not_configured')
    })
  }
})
