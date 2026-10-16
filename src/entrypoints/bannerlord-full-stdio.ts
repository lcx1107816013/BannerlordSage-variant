// Authoring entrypoint: the bannerlord profile with every tool tier registered.
//
// ★ THE ASSIGNMENT IS `=` AND NOT `||=`. This entrypoint is the explicit "give me
// everything" path, so it OVERWRITES BANNERSAGE_TOOLSET rather than defaulting it — even
// a caller who exported `query-first` gets the full tier here. Changing it to `||=` would
// silently demote this entrypoint to whatever the environment happened to hold, which is
// the opposite of what the file is for.
//
// Verified by tools/rewrite-verify/entrypoint_tiers.ts: with BANNERSAGE_TOOLSET unset,
// empty, or `query-first`, this entrypoint still reports 46 tools.
process.env.BANNERSAGE_GAME = 'bannerlord'
process.env.BANNERSAGE_TOOLSET = 'full'

/** Reports a startup failure to stderr and exits non-zero. */
function failStartup(error: unknown): never {
  console.error('Fatal startup error:', error)
  process.exit(1)
}

const { main } = await import('../stdio')

if (import.meta.main) {
  main().catch(failStartup)
}
