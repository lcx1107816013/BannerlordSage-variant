// Legacy gameplay + memory registrations, restored verbatim from
// hby7921/BannerlordSage@8311c9a.
//
// WHY THIS FILE EXISTS
// --------------------
// Our own commit b80b55f removed these 16 registrations and described them in
// its message as "16 tools that were never registered". Measured against the
// actual parent revision, that claim is false: all 16 were LIVE registerTool
// calls, and upstream's registered surface was 37, not the stale 35 the
// message counted against. The capability ledger (BannerScribe) records this
// as finding F1.
//
// The bodies below are the upstream registration blocks, not a rewrite, so the
// restored surface is provably identical to what upstream shipped. The three
// consolidated routers (get_entity / project_memory_read / project_memory_write)
// are deliberately KEPT: they reach the same handlers, and removing them would
// be a second capability change bundled into a restoration.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { archiveToolName } from '../utils/tool-naming'

import { getClanSummary } from './get-clan-summary'
import { getCultureSummary } from './get-culture-summary'
import { getHeroProfile } from './get-hero-profile'
import { getItemStats } from './get-item-stats'
import { getKingdomSummary } from './get-kingdom-summary'
import { getPerkData } from './get-perk-data'
import { getPolicySummary } from './get-policy-summary'
import { getSettlementSummary } from './get-settlement-summary'
import { getSkillData } from './get-skill-data'
import { traceTroopTree } from './trace-troop-tree'
import { projectMemoryAdd } from './project-memory-add'
import { projectMemoryCaptureSession } from './project-memory-capture-session'
import { projectMemoryInvalidate } from './project-memory-invalidate'
import { projectMemoryRecent } from './project-memory-recent'
import { projectMemorySearch } from './project-memory-search'
import { projectMemoryWakeup } from './project-memory-wakeup'

/**
 * Names restored by this module, in upstream order — in LEGACY form.
 *
 * Legacy form on purpose: the toolset lists and the tests both run these
 * through archiveToolName(), the same helper the registration calls use. One
 * naming rule, one place, so a list cannot drift from the registered surface —
 * which is precisely how the 16 tools were lost the first time.
 */
export const LEGACY_GAMEPLAY_TOOL_NAMES = [
  'project_memory_add',
  'project_memory_capture_session',
  'project_memory_search',
  'project_memory_recent',
  'project_memory_wakeup',
  'project_memory_invalidate',
  'trace_troop_tree',
  'get_item_stats',
  'get_clan_summary',
  'get_policy_summary',
  'get_hero_profile',
  'get_perk_data',
  'get_kingdom_summary',
  'get_culture_summary',
  'get_settlement_summary',
  'get_skill_data',
] as const

/** Register the 16 upstream gameplay + memory tools that b80b55f dropped. */
export function registerLegacyGameplayTools(server: McpServer): void {
  server.registerTool(
    archiveToolName('project_memory_add'),
    {
      title: 'Add Project Memory',
      description:
        'Use this to store a durable project memory such as a decision, pitfall, preference, todo, or session outcome. This is the BannerlordSage-native memory layer for cross-session continuity.',
      inputSchema: {
        text: z.string().describe('The raw memory text to preserve. Prefer verbatim reasoning, decisions, and concrete findings.'),
        workspace: z
          .string()
          .optional()
          .describe('Optional project or workspace scope, such as bannerlordsage or a specific mod name. Defaults to bannerlordsage.'),
        topic: z.string().optional().describe('Optional topic bucket, such as indexing, docs, harmony, release, or xml.'),
        kind: z
          .string()
          .optional()
          .describe('Optional memory kind such as decision, pitfall, preference, todo, session, or note.'),
        summary: z.string().optional().describe('Optional one-line summary for quick scanning.'),
        source: z.string().optional().describe('Optional source reference such as a file path, issue id, or session label.'),
        tags: z.array(z.string()).optional().describe('Optional short tags for filtering and recall.'),
        importance: z.number().optional().default(3).describe('Importance from 1 to 5. Higher values are better wake-up candidates.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async ({ text, workspace, topic, kind, summary, source, tags, importance }) =>
      await projectMemoryAdd(text, workspace, topic, kind, summary, source, tags, importance),
  )
  server.registerTool(
    archiveToolName('project_memory_capture_session'),
    {
      title: 'Capture Session Memory',
      description:
        'Use this near the end of a meaningful task to batch-store the durable conclusions from the session. It is the preferred write path for decisions, pitfalls, preferences, todos, and the concise session summary.',
      inputSchema: {
        workspace: z
          .string()
          .optional()
          .describe('Optional project or workspace scope, such as bannerlordsage or a specific mod name. Defaults to bannerlordsage.'),
        topic: z.string().optional().describe('Optional topic bucket such as memory, indexing, harmony, validation, or docs.'),
        source: z.string().optional().describe('Optional source reference such as a file path, issue id, or session label.'),
        summary: z.string().optional().describe('Optional concise session summary for future wake-up context.'),
        decisions: z.array(z.string()).optional().describe('Durable design or implementation decisions from this session.'),
        pitfalls: z.array(z.string()).optional().describe('Confirmed bugs, traps, compatibility hazards, or rejected paths worth remembering.'),
        preferences: z.array(z.string()).optional().describe('Stable user or project preferences made explicit in this session.'),
        todos: z.array(z.string()).optional().describe('Durable follow-up tasks or pending constraints that should survive context loss.'),
        notes: z.array(z.string()).optional().describe('Other reusable notes from this session that do not fit the stricter categories.'),
        sessionImportance: z.number().optional().default(3).describe('Importance from 1 to 5 for the optional session summary entry.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async ({ workspace, topic, source, summary, decisions, pitfalls, preferences, todos, notes, sessionImportance }) =>
      await projectMemoryCaptureSession(
        workspace,
        topic,
        source,
        summary,
        decisions,
        pitfalls,
        preferences,
        todos,
        notes,
        sessionImportance
      ),
  )
  server.registerTool(
    archiveToolName('project_memory_search'),
    {
      title: 'Search Project Memory',
      description:
        'Use this before answering questions about past project decisions, preferences, pitfalls, or prior session conclusions. It searches BannerlordSage-native project memory with full-text matching and metadata filters.',
      inputSchema: {
        query: z.string().describe('Search text describing the past decision, issue, preference, or context you want to recall.'),
        workspace: z.string().optional().describe('Optional workspace or project filter.'),
        topic: z.string().optional().describe('Optional topic filter.'),
        kind: z.string().optional().describe('Optional kind filter such as decision, pitfall, or preference.'),
        limit: z.number().optional().default(5).describe('Maximum number of memories to return.'),
        includeInactive: z.boolean().optional().default(false).describe('When true, include invalidated memories in the results.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, workspace, topic, kind, limit, includeInactive }) =>
      await projectMemorySearch(query, workspace, topic, kind, limit, includeInactive),
  )
  server.registerTool(
    archiveToolName('project_memory_recent'),
    {
      title: 'Recent Project Memory',
      description:
        'Use this to review the latest stored project memories for a workspace or topic, especially when resuming work after a break.',
      inputSchema: {
        workspace: z.string().optional().describe('Optional workspace or project filter.'),
        topic: z.string().optional().describe('Optional topic filter.'),
        kind: z.string().optional().describe('Optional kind filter.'),
        limit: z.number().optional().default(8).describe('Maximum number of memories to return.'),
        includeInactive: z.boolean().optional().default(false).describe('When true, include invalidated memories.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, topic, kind, limit, includeInactive }) =>
      await projectMemoryRecent(workspace, topic, kind, limit, includeInactive),
  )
  server.registerTool(
    archiveToolName('project_memory_wakeup'),
    {
      title: 'Project Memory Wake-up',
      description:
        'Use this at the start of a coding session to load the most important active project memories for a workspace, biased toward decisions, pitfalls, and preferences.',
      inputSchema: {
        workspace: z.string().optional().describe('Optional workspace or project filter.'),
        limit: z.number().optional().default(8).describe('Maximum number of wake-up memories to return.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace, limit }) => await projectMemoryWakeup(workspace, limit),
  )
  server.registerTool(
    archiveToolName('project_memory_invalidate'),
    {
      title: 'Invalidate Project Memory',
      description:
        'Use this when an older project memory is no longer valid because the design changed, a decision was reversed, or a previous conclusion was disproven.',
      inputSchema: {
        memoryId: z.string().describe('Exact memory id returned by the project memory tools.'),
        reason: z.string().optional().describe('Optional reason explaining why the memory is no longer valid.'),
      },
      annotations: {
        readOnlyHint: false,
        openWorldHint: false,
      },
    },
    async ({ memoryId, reason }) => await projectMemoryInvalidate(memoryId, reason),
  )
  server.registerTool(
    archiveToolName('trace_troop_tree'),
    {
      title: 'Trace Troop Tree',
      description:
        'Use this when you already know a troop character ID and want a focused upgrade-tree summary without manually traversing NPCCharacter XML. This reads the precomputed troop projection table, so it is faster and more reliable than reparsing XML fragments for each request.',
      inputSchema: {
        characterId: z.string().describe('Exact troop ID such as vlandian_recruit or imperial_infantryman.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ characterId }) => await traceTroopTree(characterId),
  )
  server.registerTool(
    archiveToolName('get_item_stats'),
    {
      title: 'Get Item Stats',
      description:
        'Use this when you already know an item ID or crafting-piece ID and need a condensed gameplay-facing summary. Prefer this over raw XML reading for weapons, armor, horses, and smithing parts because it reads the precomputed item projection table and formats the key stats directly.',
      inputSchema: {
        itemId: z.string().describe('Exact item or crafting piece ID, for example saddle_horse or sword_blade_4_t3.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ itemId }) => await getItemStats(itemId),
  )
  server.registerTool(
    archiveToolName('get_clan_summary'),
    {
      title: 'Get Clan Summary',
      description:
        'Use this when you already know a clan or faction ID from spclans.xml and want its resolved culture, owner hero, home settlement, and super-faction without manually joining multiple XML files. This reads the precomputed clan projection table and is especially useful for noble clans, minor factions, mercenaries, and bandit groups.',
      inputSchema: {
        clanId: z.string().describe('Exact clan or faction ID such as clan_empire_north_3, player_faction, or ghilman.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ clanId }) => await getClanSummary(clanId),
  )
  server.registerTool(
    archiveToolName('get_policy_summary'),
    {
      title: 'Get Policy Summary',
      description:
        'Use this when you know a kingdom policy ID and want the fully resolved policy text, support weights, current active kingdoms, and default cultures without manually stitching source-defined policy objects to XML kingdom and culture references. This reads the hybrid gameplay index built from both decompiled source and XML projections.',
      inputSchema: {
        policyId: z.string().describe('Exact policy ID such as policy_feudal_inheritance or policy_royal_privilege.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ policyId }) => await getPolicySummary(policyId),
  )
  server.registerTool(
    archiveToolName('get_hero_profile'),
    {
      title: 'Get Hero Profile',
      description:
        'Use this when you already know a hero ID and want the merged relationship and character summary without manually joining Heroes XML and NPCCharacter XML. This reads the precomputed hero projection table and joins it with indexed troop data.',
      inputSchema: {
        heroId: z.string().describe('Exact hero ID such as lord_1_1 or main_hero.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ heroId }) => await getHeroProfile(heroId),
  )
  server.registerTool(
    archiveToolName('get_perk_data'),
    {
      title: 'Get Perk Data',
      description:
        'Use this when you know a single-player perk ID and want its skill tree placement, paired alternative perk, role bonuses, increment types, and localized descriptions without searching the large DefaultPerks source file manually. This reads the hybrid gameplay index extracted from decompiled campaign source.',
      inputSchema: {
        perkId: z.string().describe('Exact perk ID such as OneHandedWrappedHandles, BowBowControl, or LeadershipFerventAttacker.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ perkId }) => await getPerkData(perkId),
  )
  server.registerTool(
    archiveToolName('get_kingdom_summary'),
    {
      title: 'Get Kingdom Summary',
      description:
        'Use this when you know a kingdom ID and want a focused summary of ruler, culture, capital/home settlement, colors, and policy counts without reparsing spkingdoms.xml. This reads the precomputed kingdom projection table.',
      inputSchema: {
        kingdomId: z.string().describe('Exact kingdom ID such as empire, battania, or aserai.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ kingdomId }) => await getKingdomSummary(kingdomId),
  )
  server.registerTool(
    archiveToolName('get_culture_summary'),
    {
      title: 'Get Culture Summary',
      description:
        'Use this when you already know a culture ID and want a fast summary of core culture metadata, localized description text, troop roots, and name pools. This reads the precomputed culture projection table instead of reparsing the large cultures XML file.',
      inputSchema: {
        cultureId: z.string().describe('Exact culture ID such as empire, battania, or khuzait.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ cultureId }) => await getCultureSummary(cultureId),
  )
  server.registerTool(
    archiveToolName('get_settlement_summary'),
    {
      title: 'Get Settlement Summary',
      description:
        'Use this when you know a settlement ID and want a fast summary of settlement type, owner faction, derived kingdom, village bindings, scenes, and prosperity/hearth values. This reads the precomputed settlement projection table instead of reparsing settlements.xml and related faction XML.',
      inputSchema: {
        settlementId: z.string().describe('Exact settlement ID such as town_B1, castle_EN1, or castle_village_EN1_1.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ settlementId }) => await getSettlementSummary(settlementId),
  )
  server.registerTool(
    archiveToolName('get_skill_data'),
    {
      title: 'Get Skill Data',
      description:
        'Use this when you know a skill XML ID and want its modifier list and documentation without opening the full skills XML. This reads the precomputed skill projection table and is best for quickly understanding attribute modifiers.',
      inputSchema: {
        skillId: z.string().describe('Exact skill XML ID such as IronFlesh1 or PowerStrike1.'),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: false,
      },
    },
    async ({ skillId }) => await getSkillData(skillId),
  )
}
