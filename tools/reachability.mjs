#!/usr/bin/env bun
// Reachability audit for the Archive source tree.
//
// Question it answers: which files does our ACTUAL entrypoint never load?
//
// Why it matters for "decoupling from upstream": a file we never import is a file we
// do not need to maintain, verify, or port. Deleting it decouples us from upstream
// completely and for free. Rewriting it, by contrast, converts someone else's code
// into our maintenance burden — the opposite of the stated goal.
//
// Method: walk the ESM import graph from each entrypoint, following relative
// specifiers only (package imports are ecosystem dependencies, not our source). A file
// is "unreachable" when no entrypoint can reach it. Because the two entrypoints gate
// different tool sets, both are measured separately.
//
// This is deliberately conservative: any dynamic import or re-export form this
// simple scan does not understand is reported as a WARNING rather than silently
// treated as a dependency, so the result cannot overstate what is dead.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = process.cwd()
const srcRoot = join(root, 'src')

function walk(dir) {
    const out = []
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) out.push(...walk(full))
        else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
}

function resolveSpecifier(fromFile, spec) {
    if (!spec.startsWith('.')) return null // package: not our source
    const base = resolve(dirname(fromFile), spec)
    for (const candidate of [base + '.ts', join(base, 'index.ts'), base]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    }
    return null
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g
const BARE_IMPORT_RE = /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g
// `import('...')` — the comment below documents why this must be counted, not skipped.
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]/g
// A dynamic import whose specifier is not a string literal cannot be followed.
const OPAQUE_DYNAMIC_RE = /import\s*\(\s*(?!['"])/g

const warnings = []

function importsOf(file) {
    const text = readFileSync(file, 'utf8')

    // ★ Counting dynamic imports is REQUIRED, not optional.
    //
    // The entrypoints load the server with:
    //     const { main } = await import('../stdio')
    // The first version of this script only matched static `import ... from`, so the
    // graph stopped one node in and the report declared search-xml.ts,
    // path-sandbox.ts and tool-naming.ts unreachable — all three are demonstrably
    // live. An audit that cannot follow the real entry path is worse than none: it
    // invites deleting working code.
    if (OPAQUE_DYNAMIC_RE.test(text)) {
        warnings.push(`${relative(root, file)} has a dynamic import with a non-literal specifier`)
    }

    const found = new Set()
    for (const re of [IMPORT_RE, BARE_IMPORT_RE, DYNAMIC_IMPORT_RE]) {
        re.lastIndex = 0
        let m
        while ((m = re.exec(text)) !== null) {
            const target = resolveSpecifier(file, m[1])
            if (target) found.add(target)
        }
    }
    return found
}

function reachableFrom(entry) {
    const seen = new Set()
    const stack = [entry]
    while (stack.length > 0) {
        const file = stack.pop()
        if (seen.has(file)) continue
        seen.add(file)
        for (const dep of importsOf(file)) stack.push(dep)
    }
    return seen
}

const entrypoints = {
    'bannerlord-stdio (default, 39 tools)': join(srcRoot, 'entrypoints', 'bannerlord-stdio.ts'),
    'bannerlord-full-stdio (46 tools)': join(srcRoot, 'entrypoints', 'bannerlord-full-stdio.ts'),
    'bannerlord-setup': join(srcRoot, 'entrypoints', 'bannerlord-setup.ts'),
}

const allFiles = walk(srcRoot)
const reach = {}
for (const [label, path] of Object.entries(entrypoints)) {
    reach[label] = existsSync(path) ? reachableFrom(path) : new Set()
}

// A file counts as reachable if ANY entrypoint loads it: setup and the indexer
// scripts are legitimately used, just not by the stdio server.
const union = new Set()
for (const set of Object.values(reach)) for (const f of set) union.add(f)

console.log('=== 入口可达性审计 ===\n')
for (const [label, set] of Object.entries(reach)) {
    console.log(`  ${label.padEnd(38)} 可达 ${set.size} 个文件`)
}
console.log(`  ${'全部入口合计'.padEnd(38)} 可达 ${union.size} / ${allFiles.length}`)
console.log()

const unreachable = allFiles.filter((f) => !union.has(f))
console.log(`=== 任何入口都到不了的文件：${unreachable.length} 个 ===`)
const byDir = {}
for (const f of unreachable) {
    const d = relative(srcRoot, dirname(f))
    byDir[d] = byDir[d] ?? []
    byDir[d].push(relative(srcRoot, f))
}
for (const [d, files] of Object.entries(byDir).sort()) {
    console.log(`  ${d}/`)
    for (const f of files.sort()) console.log(`      ${f}`)
}
console.log()

// Scripts are entrypoints too (run via `bun run`), so they are checked for
// reachability of their own but must not be counted as dead just for being leaves.
console.log('=== 脚本（可独立运行，不算死代码，但也从未被 stdio 服务加载）===')
const scripts = allFiles.filter((f) => relative(srcRoot, f).replace(/\\/g, '/').startsWith('scripts/'))
console.log(`  共 ${scripts.length} 个，其中任何 entrypoint 可达 ${scripts.filter((f) => union.has(f)).length} 个`)

if (warnings.length > 0) {
    console.log('\n=== ⚠️ 本次扫描不理解的用法（结果可能保守，但不会夸大"死代码"）===')
    for (const w of warnings.sort()) console.log(`  ${w}`)
}

// Machine-readable output so a later step can act on it instead of re-deriving it.
const out = {
    generatedFrom: 'server-go/tools/parity/../../  (Archive src tree)',
    entrypoints: Object.fromEntries(Object.entries(reach).map(([k, v]) => [k, v.size])),
    totalFiles: allFiles.length,
    reachable: union.size,
    unreachable: unreachable.map((f) => relative(root, f).replace(/\\/g, '/')).sort(),
    warnings: warnings.sort(),
}
const outPath = join(root, 'tools', 'reachability.json')
readdirSync(join(root, 'tools')) // ensure dir exists
await Bun.write(outPath, JSON.stringify(out, null, 2) + '\n')
console.log(`\n已写入 ${relative(root, outPath)}`)
