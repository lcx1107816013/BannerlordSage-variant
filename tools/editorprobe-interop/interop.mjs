// Interop test: drive the REAL C# EditorProbe with the REAL TypeScript client.
//
// This is the strongest check available without launching the game. Everything
// else in this project verifies one side against fixtures or assertions written on
// the same side. Here the archive's own client module — the exact code the
//   ba_editor_* MCP tools run — reads the session file the C# probe wrote, opens a
// TCP connection to the C# listener, and interprets the reply.
//
// What it proves:
//   - the session file satisfies every gate the client enforces (paths, SceneObj
//     containment, scene name regex, BOTH bin variants reporting v1.4.8)
//   - the wire envelope is accepted (parsed, ok is a boolean, the reply is bounded)
//   - result fields the client depends on are present and correct
//   - the client's own active-scene gate evaluates correctly against real data
//
// What it cannot prove: entering the editor, which needs the game running.
//
// Usage:
//   bun run tools/editorprobe-interop/interop.mjs <sessionPath> <expectedModuleDir>

import { editorStatus, editorToolResult, requestEditor } from '../../src/utils/bannerlord-editor-client.ts'

const sessionPath = process.argv[2]
const expectedModuleDir = process.argv[3]

if (!sessionPath) {
    console.error('FATAL: pass the session path')
    process.exit(2)
}

let pass = 0
let fail = 0
function ok(name, condition, detail) {
    if (condition) {
        pass++
        console.log(`  [ok]   ${name}`)
    } else {
        fail++
        console.log(`  [FAIL] ${name}${detail === undefined ? '' : '  <- ' + detail}`)
    }
}

// The client reads this env var when no explicit sessionPath is passed, mirroring
// how the ba_editor_* tools are configured in production.
process.env.BANNERSAGE_EDITOR_PROBE_SESSION = sessionPath

console.log('== Archive 客户端 <-> EditorProbe 互通断言 ==\n')
console.log(`  session: ${sessionPath}`)
console.log(`  module : ${expectedModuleDir}\n`)

console.log('[1] 客户端加载 session 并握手（requestEditor status）')

let status
try {
    status = await requestEditor('status')
} catch (error) {
    fail++
    console.log(`  [FAIL] requestEditor 抛出: ${error?.code ?? ''} ${error?.message ?? error}`)
    console.log('\n== 有失败 ==')
    process.exit(1)
}

// A thrown EditorClientError above would already have caught a session or
// transport problem: not_configured / invalid_session / version_mismatch /
// disconnected / timeout / invalid_response all surface there. Reaching this line
// means the client accepted the session file AND got a well-formed reply.
ok('客户端接受了 session 文件（全部路径/场景/版本门禁通过）', true)
ok('应答 ok === true', status.ok === true, JSON.stringify(status).slice(0, 200))
ok('应答带 result 对象', status.result !== undefined && status.result !== null)
ok('mainThread 与 executedThread 都在', status.mainThread !== undefined && status.executedThread !== undefined)
ok('mainThread === executedThread（否则客户端报 wrong_thread）', status.mainThread === status.executedThread, `main=${status.mainThread} exec=${status.executedThread}`)
ok('result.editMode 如实为 false（游戏没在跑）', status.result.editMode === false)
ok('result.scene 报告 probeScene', status.result.scene === 'ProbeScene', String(status.result.scene))
ok('result.resolvedSceneModule 等于模块目录', status.result.resolvedSceneModule === expectedModuleDir, String(status.result.resolvedSceneModule))

console.log('\n[2] 客户端高层入口（editorStatus）')

const st = await editorStatus()
console.log(`       state=${st.state} connected=${st.connected} configured=${st.configured} activeSceneMatches=${st.activeSceneMatches}`)
ok('state === ready', st.state === 'ready', String(st.state))
ok('connected === true', st.connected === true)
ok('configured === true', st.configured === true)
// editMode is false, so the scene is genuinely not open. Reporting true here would
// be the client lying on our behalf.
ok('activeSceneMatches 如实为 false（编辑器确实没开）', st.activeSceneMatches === false)
ok('validatedVersion === v1.4.8', st.validatedVersion === 'v1.4.8')
ok('configuredScene 是 ProbeScene', st.configuredScene === 'ProbeScene')

console.log('\n[3] 客户端自己的活动场景闸门（editorToolResult entities）')

const entities = await editorToolResult('entities', {}, undefined, true)
// The client calls requireActiveScene first, which issues its own `status` and then
// rejects because editMode is false. Getting wrong_scene here proves the gate ran
// against real data rather than being short-circuited.
const text = entities.content?.[0]?.text ?? '{}'
let parsed = {}
try {
    parsed = JSON.parse(text)
} catch {
    // leave as {}
}
console.log(`       isError=${entities.isError} code=${parsed.code}`)
ok('isError === true', entities.isError === true)
ok('code === wrong_scene（客户端闸门真的在拦）', parsed.code === 'wrong_scene', String(parsed.code))
ok('错误信息来自客户端自己的词表', typeof parsed.error === 'string' && parsed.error.length > 0)

console.log('\n[4] 客户端不会把探测的 token 泄漏进结果')
const dumped = JSON.stringify(status) + JSON.stringify(st)
const leaked = sessionPath && dumped.includes('token')
ok('结果里不含 token 字段', !/"(token|authorization|password|secret)"/i.test(dumped))

console.log(`\n== ${fail === 0 ? '全部通过' : '有失败'}（${pass + fail} 项，失败 ${fail}）==`)
process.exit(fail === 0 ? 0 : 1)
