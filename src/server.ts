import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { PathSandbox } from './utils/path-sandbox'
import { activeGameId, assetsPath } from './utils/env'
import { getBannerlordToolsetMode } from './utils/bannerlord-toolset'
import { bannerlordIndexStatus } from './tools/bannerlord-index-status'
import { bannerlordDoctor } from './tools/bannerlord-doctor'
import { registerBannerlordEditorTools } from './tools/bannerlord-editor'
import { createModWorkspace } from './tools/create-mod-workspace'
import { generateHarmonyPatch } from './tools/generate-harmony-patch'
import { generateXsltPatch } from './tools/generate-xslt-patch'
import { getEntity } from './tools/get-entity'
import { indexModSource } from './tools/index-mod-source'
import { listDirectory } from './tools/list-directory'
import { listModDirectory } from './tools/list-mod-directory'
import { modSourceStatus } from './tools/mod-source-status'
import { projectMemoryRead, projectMemoryWrite } from './tools/project-memory-rw'
import { readCsharpType } from './tools/read-csharp-type'
import { readFile } from './tools/read-file'
import { readGauntletUi } from './tools/read-gauntlet-ui'
import { readModFile } from './tools/read-mod-file'
import { readModType } from './tools/read-mod-type'
import { resolveLocalization } from './tools/resolve-localization'
import { searchApiDocs } from './tools/search-api-docs'
import { searchDocs } from './tools/search-docs'
import { searchKnowledge } from './tools/search-knowledge'
import { searchModSource } from './tools/search-mod-source'
import { searchSource } from './tools/search-source'
import { searchXml } from './tools/search-xml'

const sandbox = new PathSandbox(assetsPath)
const bannerlordToolsetMode = getBannerlordToolsetMode()

export const server = new McpServer({
  name: 'bannerlord-sage',
  version: '1.0.0',
})

registerBannerlordEditorTools(server, bannerlordToolsetMode)

server.registerTool(
  'bannerlord_doctor',
  {
    title: 'Bannerlord Doctor',
    description:
      'Scan a real Bannerlord install for module dependency problems, duplicate libraries, missing SubModule DLLs, bad load order. Reads the live install directory, not the imported index. Returns focused issues and a recommended load order.',
    inputSchema: {
      gameDir: z.string().optional().describe('Install path. Defaults to saved setup state.'),
      moduleId: z.string().optional().describe('Exact module id, e.g. MercenaryGuild.'),
      modulePath: z.string().optional().describe('Absolute module dir; use for duplicate ids.'),
      includeOfficialDetails: z.boolean().optional().default(false).describe('Include official module details.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ gameDir, moduleId, modulePath, includeOfficialDetails }) =>
    await bannerlordDoctor(gameDir, moduleId, modulePath, includeOfficialDetails),
)

server.registerTool(
  'bannerlord_index_status',
  {
    title: 'Bannerlord Index Status',
    description:
      'Inspect BannerlordSage runtime state: active scopes, indexed table counts, XML parse failures, missing DLL coverage, toolset mode.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async () => await bannerlordIndexStatus('bannerlord'),
)

server.registerTool(
  'project_memory_write',
  {
    title: 'Write Project Memory',
    description:
      'Write to the cross-session project memory layer. add: store one memory; capture_session: batch-store session conclusions; invalidate: mark a memory obsolete.',
    inputSchema: {
      action: z.enum(['add', 'capture_session', 'invalidate']).describe('add needs text; invalidate needs memoryId; capture_session batch-stores session conclusions.'),
      text: z.string().optional().describe('Memory text (required for add). Prefer verbatim decisions and findings.'),
      memoryId: z.string().optional().describe('Memory id (required for invalidate).'),
      reason: z.string().optional().describe('Why the memory is obsolete.'),
      workspace: z.string().optional().describe('Workspace scope. Defaults to bannerlordsage.'),
      topic: z.string().optional().describe('Topic bucket, e.g. indexing, harmony, xml.'),
      kind: z.string().optional().describe('Memory kind, e.g. decision, pitfall, preference, todo.'),
      summary: z.string().optional().describe('One-line summary.'),
      source: z.string().optional().describe('Source reference, e.g. file path or session label.'),
      tags: z.array(z.string()).optional().describe('Short tags for recall.'),
      importance: z.number().optional().describe('1-5 (default 3). Higher is a better wake-up candidate.'),
      decisions: z.array(z.string()).optional().describe('capture_session: durable decisions.'),
      pitfalls: z.array(z.string()).optional().describe('capture_session: confirmed bugs and traps.'),
      preferences: z.array(z.string()).optional().describe('capture_session: stable preferences.'),
      todos: z.array(z.string()).optional().describe('capture_session: pending follow-ups.'),
      notes: z.array(z.string()).optional().describe('capture_session: other reusable notes.'),
      sessionImportance: z.number().optional().describe('capture_session: 1-5 (default 3).'),
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
  },
  async input => await projectMemoryWrite(input.action, input),
)

server.registerTool(
  'project_memory_read',
  {
    title: 'Read Project Memory',
    description:
      'Read the cross-session project memory layer. search: full-text query, use before claiming project history; recent: newest entries; wakeup: top-priority active entries at session start.',
    inputSchema: {
      action: z.enum(['search', 'recent', 'wakeup']).describe('search needs query; recent lists newest; wakeup loads top-priority active memories.'),
      query: z.string().optional().describe('Search text (required for search).'),
      workspace: z.string().optional().describe('Workspace or project filter.'),
      topic: z.string().optional().describe('Topic filter, e.g. indexing, harmony, xml.'),
      kind: z.string().optional().describe('Kind filter, e.g. decision, pitfall, preference.'),
      limit: z.number().optional().describe('Max entries (default 5 search / 8 recent,wakeup).'),
      includeInactive: z.boolean().optional().default(false).describe('Include invalidated memories.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ action, query, workspace, topic, kind, limit, includeInactive }) =>
    await projectMemoryRead(action, { query, workspace, topic, kind, limit, includeInactive }),
)

server.registerTool(
  'mod_source_status',
  {
    title: 'Local Mod Source Status',
    description: 'Inspect a local mod source workspace: resolved source root and indexed type/member counts.',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot }) => await modSourceStatus(workspaceRoot),
)

server.registerTool(
  'index_mod_source',
  {
    title: 'Index Local Mod Source',
    description: 'Build or refresh the incremental C# index for a local mod source dir (reindexes only changed files).',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot }) => await indexModSource(workspaceRoot),
)

server.registerTool(
  'search_mod_source',
  {
    title: 'Search Local Mod Source',
    description: 'ripgrep over your local mod source tree (not the imported decompile tree). Fastest for frequently edited mod code.',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
      query: z.string().describe('Keyword or regex.'),
      caseSensitive: z.boolean().optional().default(false).describe('Case-sensitive search.'),
      filePattern: z.string().optional().describe('Glob filter, e.g. *.cs or *Patch*.cs.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot, query, caseSensitive, filePattern }) =>
    await searchModSource(workspaceRoot, query, caseSensitive, filePattern),
)

server.registerTool(
  'read_mod_file',
  {
    title: 'Read Local Mod File',
    description: 'Read a line slice from your local mod source tree (live files, edits visible immediately).',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
      path: z.string().describe('Path relative to source root.'),
      startLine: z.number().optional().default(0).describe('Zero-based start line.'),
      lineCount: z.number().optional().default(400).describe('Max lines.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot, path, startLine, lineCount }) => await readModFile(workspaceRoot, path, startLine, lineCount),
)

server.registerTool(
  'list_mod_directory',
  {
    title: 'List Local Mod Directory',
    description: 'List files and subdirs under your local mod source workspace.',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
      path: z.string().optional().default('').describe('Dir relative to source root.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot, path }) => await listModDirectory(workspaceRoot, path),
)

server.registerTool(
  'read_mod_type',
  {
    title: 'Read Local Mod Type',
    description: 'Read a class/struct/interface/enum definition from your local mod source (cache refreshes on change).',
    inputSchema: {
      workspaceRoot: z.string().optional().describe('Workspace root or src dir. Defaults to BANNERSAGE_MOD_SOURCE_DIR.'),
      typeName: z.string().describe('Exact type name, e.g. SubModule.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ workspaceRoot, typeName }) => await readModType(workspaceRoot, typeName),
)

if (bannerlordToolsetMode === 'full') {
  server.registerTool(
    'create_mod_workspace',
    {
      title: 'Create Mod Workspace',
      description:
        'Scaffold a local Bannerlord mod workspace: SubModule.xml, English localization, a compilable C# project wired to the local game install, optional CampaignBehavior/Harmony samples.',
      inputSchema: {
        workspaceRoot: z.string().describe('Parent dir receiving the <moduleId> folder. Refuses non-empty target.'),
        moduleId: z.string().regex(/^[A-Za-z0-9_.]+$/).describe('Module id + folder name, e.g. MercenaryGuild.'),
        moduleName: z.string().optional().describe('Display name in SubModule.xml and README.'),
        namespace: z.string().optional().describe('Root C# namespace. Defaults to sanitized moduleId.'),
        authors: z.string().optional().describe('Author string for .csproj and README.'),
        version: z.string().optional().describe('Version, 1.0.0 or v1.0.0.'),
        url: z.string().optional().describe('Metadata URL for SubModule.xml.'),
        updateInfo: z.string().optional().describe('Update descriptor, e.g. NexusMods:1234.'),
        gameDir: z.string().optional().describe('Install path. Defaults to saved setup state.'),
        includeCampaignBehavior: z.boolean().optional().default(true).describe('Generate CampaignBehavior scaffold.'),
        includeHarmonyExample: z.boolean().optional().default(false).describe('Generate a no-op Harmony postfix example.'),
        includeButterLib: z.boolean().optional().default(false).describe('Declare ButterLib dependency.'),
        includeUiExtenderEx: z.boolean().optional().default(false).describe('Declare UIExtenderEx dependency.'),
        includeMcm: z.boolean().optional().default(false).describe('Declare MBOptionScreen dependency.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async input => await createModWorkspace(input),
  )
}

server.registerTool(
  'read_csharp_type',
  {
    title: 'Read C# Type',
    description: 'Get the decompiled definition of a known Bannerlord type. Prefer over text search for classes/structs/enums.',
    inputSchema: {
      typeName: z.string().describe('Exact type name, e.g. MobileParty or Hero.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ typeName }) => await readCsharpType(typeName),
)

server.registerTool(
  'search_source',
  {
    title: 'Search Decompiled Source',
    description: 'ripgrep the decompiled C# source tree. Use when the exact type/method location is unknown.',
    inputSchema: {
      query: z.string().describe('Keyword or regex. Keep narrow, e.g. CalculateSpeed.'),
      filePattern: z.string().optional().describe('Glob filter, e.g. *.cs or */CampaignSystem/*.cs.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, filePattern }) => await searchSource(sandbox, query, false, filePattern),
)

server.registerTool(
  'read_file',
  {
    title: 'Read Indexed File Slice',
    description: 'Read a slice of an indexed source or XML file. Read only the relevant region to save context.',
    inputSchema: {
      path: z
        .string()
        .describe(`Path relative to dist/games/${activeGameId}/assets, e.g. Xmls/Modules/Native/ModuleData/crafting_pieces.xml.`),
      startLine: z.number().optional().default(0).describe('Zero-based start line.'),
      lineCount: z.number().optional().default(400).describe('Max lines.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ path, startLine, lineCount }) => await readFile(sandbox, path, startLine, lineCount),
)

server.registerTool(
  'list_directory',
  {
    title: 'List Indexed Directory',
    description: `Explore what has been imported into dist/games/${activeGameId}/assets before opening a file.`,
    inputSchema: {
      path: z.string().optional().default('').describe('Dir relative to assets root; empty lists top level.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ path }) => await listDirectory(sandbox, path),
)

server.registerTool(
  'search_xml',
  {
    title: 'Search XML Data',
    description: 'Full-text lookup across imported XML (ModuleData, Languages). Find which files mention an entity or token.',
    inputSchema: {
      query: z.string().describe('1-4 focused keywords.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query }) => await searchXml(query),
)

server.registerTool(
  'search_bannerlord_knowledge',
  {
    title: 'Search Bannerlord Knowledge',
    description:
      'Natural-language entry point: searches official tutorials, community docs, API symbols and decompiled source together. When the API version does not match the installed game, official API hits are reference-only and decompiled source wins. Use for "调用 mcp 查一下"/"我要做一个 mod"/"怎么写补丁"/"帮我查这个类".',
    inputSchema: {
      query: z.string().describe('Natural-language request, e.g. "我要做一个招募俘虏的 mod".'),
      intent: z.enum(['auto', 'make_mod', 'api', 'docs', 'source']).optional().default('auto').describe('Routing hint; leave auto.'),
      limit: z.number().optional().default(5).describe('Max results per source.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, intent, limit }) => await searchKnowledge(sandbox, query, intent, limit),
)

server.registerTool(
  'search_bannerlord_docs',
  {
    title: 'Search Bannerlord Modding Docs',
    description: 'Search official modding tutorials and BannerlordModding.LT community docs. Best for concepts, workflows, Gauntlet UI, module structure.',
    inputSchema: {
      query: z.string().describe('Keywords, e.g. Gauntlet UI or SubModule.'),
      source: z.enum(['all', 'official', 'community']).optional().default('all').describe('Docs source filter.'),
      limit: z.number().optional().default(8).describe('Max matches.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, source, limit }) => await searchDocs(query, source, limit),
)

server.registerTool(
  'search_bannerlord_api_docs',
  {
    title: 'Search Bannerlord Official API Docs',
    description: 'Search official Bannerlord API Doxygen symbols. Reports version match; prefer decompiled source when versions differ.',
    inputSchema: {
      query: z.string().describe('Symbol or keyword, e.g. Hero or MBObjectManager.'),
      version: z.string().optional().describe('API version, e.g. 1.3.14. Defaults to installed game version.'),
      section: z.enum(['classes', 'functions', 'properties', 'events', 'enums', 'enumvalues', 'variables']).optional().describe('Doxygen section filter.'),
      limit: z.number().optional().default(10).describe('Max matches.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ query, version, section, limit }) => await searchApiDocs(query, version, section, limit),
)

server.registerTool(
  'get_entity',
  {
    title: 'Get Gameplay Entity',
    description:
      'Look up one Bannerlord gameplay entity by id from the precomputed projection tables. Prefer over reading raw XML. kind: clan, culture, hero, item, kingdom, perk, policy, settlement, skill, troop.',
    inputSchema: {
      kind: z
        .enum(['clan', 'culture', 'hero', 'item', 'kingdom', 'perk', 'policy', 'settlement', 'skill', 'troop'])
        .describe('Entity kind to look up.'),
      id: z
        .string()
        .describe('Exact id, e.g. clan_empire_north_3, saddle_horse, lord_1_1, vlandian_recruit, town_B1.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ kind, id }) => await getEntity(kind, id),
)

server.registerTool(
  'generate_harmony_patch',
  {
    title: 'Generate Harmony Patch',
    description: 'Generate a Harmony patch scaffold for a known target method. Uses the AST method index, so overload/static details are correct.',
    inputSchema: {
      className: z.string().describe('Class name, e.g. MobileParty.'),
      methodName: z.string().describe('Method name, e.g. CalculateSpeed.'),
    },
  },
  async ({ className, methodName }) => await generateHarmonyPatch(className, methodName),
)

if (bannerlordToolsetMode === 'full') {
  server.registerTool(
    'generate_xslt_patch',
    {
      title: 'Generate XSLT Patch',
      description: 'Generate an XSLT patch for Bannerlord XML instead of editing source XML directly.',
      inputSchema: {
        targetXPath: z.string().describe("XPath to target node, e.g. /Items/Item[@id='saddle_horse']."),
        operation: z.enum(['insert', 'replace', 'delete']).describe('insert appends inside target; replace swaps target; delete removes it.'),
        fragment: z.string().optional().describe('XML fragment to insert or replace with. Omit for delete.'),
      },
    },
    async ({ targetXPath, operation, fragment }) =>
      await generateXsltPatch(targetXPath, operation, fragment),
  )
}

server.registerTool(
  'resolve_localization',
  {
    title: 'Resolve Localization Token',
    description: 'Resolve a {=token}Fallback string to its localized text (Languages XML + source fallback literals).',
    inputSchema: {
      text: z.string().describe('Token like {=P1rL28RT}Sumpter Horse.'),
      languages: z.array(z.string()).optional().describe('Preferred language order, e.g. ["English", "CN"].'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ text, languages }) => await resolveLocalization(text, languages),
)

server.registerTool(
  'read_gauntlet_ui',
  {
    title: 'Read Gauntlet UI',
    description: 'Get a ViewModel binding checklist for a Gauntlet UI XML: DataSource fields and click handlers.',
    inputSchema: {
      uiFileName: z.string().describe('UI XML stem, e.g. InventoryScreen.'),
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
    },
  },
  async ({ uiFileName }) => await readGauntletUi(sandbox, uiFileName),
)
