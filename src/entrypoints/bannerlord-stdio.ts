// Default entrypoint: the bannerlord profile on the query-first tool tier.
//
// ★ THE `||=` IS LOAD-BEARING, and `??=` is NOT equivalent. The toolset resolver treats
// anything that is not exactly the string `query-first` as `full`, so an EMPTY
// BANNERSAGE_TOOLSET means "the operator cleared it" only if the default gets applied:
//
//     BANNERSAGE_TOOLSET=""  ->  ||= gives 'query-first'  ->  query-first tier
//                                ??= leaves ""            ->  resolver falls back to full
//
// The two spellings therefore disagree on the empty string, and an earlier draft of this
// rewrite used `??=` on the reasoning that "the nullish form is the safer default" — that
// was wrong, and the entrypoint smoke run is what would have caught it if it had shipped.
process.env.BANNERSAGE_GAME = 'bannerlord'
process.env.BANNERSAGE_TOOLSET ||= 'query-first'

/** Reports a startup failure to stderr and exits non-zero. */
function failStartup(error: unknown): never {
  console.error('Fatal startup error:', error)
  process.exit(1)
}

const { main } = await import('../stdio')

if (import.meta.main) {
  main().catch(failStartup)
}
