// One-off mutation injector for the reverse-validation runs.
// usage: bun run tools/rewrite-verify/inject.mjs <file> <findLiteral> <replaceLiteral>
import { readFileSync, writeFileSync } from 'node:fs'

const [file, find, replace] = process.argv.slice(2)
const source = readFileSync(file, 'utf8')
if (!source.includes(find)) {
    console.error('PATTERN NOT FOUND in ' + file + ':\n' + JSON.stringify(find))
    process.exit(2)
}
writeFileSync(file, source.replace(find, replace), 'utf8')
console.log('injected into ' + file)
