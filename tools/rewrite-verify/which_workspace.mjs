// Which source root owns a given dist/mod-sources/<id> cache directory?
// The id is sha1(lowercased, forward-slashed absolute root)[:12], and the cache
// path is derived from the SAME configuration the code under test reads - which is
// exactly why identifying the owner matters before anything is deleted (parity
// README, F19).
//
// usage: bun run tools/rewrite-verify/which_workspace.mjs <12-hex-id> <root> [<root> ...]
import { createHash } from 'node:crypto'

const [target, ...roots] = process.argv.slice(2)
if (!target || roots.length === 0) {
    console.error('usage: bun run tools/rewrite-verify/which_workspace.mjs <id> <root> [root...]')
    process.exit(2)
}

const workspaceIdFor = root => {
    const canonical = root.replaceAll('\\', '/').toLowerCase()
    return createHash('sha1').update(canonical).digest('hex').slice(0, 12)
}

let matched = 0
for (const root of roots) {
    const id = workspaceIdFor(root)
    const isMatch = id === target
    if (isMatch) matched += 1
    console.log(`${isMatch ? '*** MATCH ***' : '            '} ${id}  <- ${root}`)
}
console.log(`\n${matched} of ${roots.length} candidate roots hash to ${target}`)
process.exit(matched > 0 ? 0 : 1)
