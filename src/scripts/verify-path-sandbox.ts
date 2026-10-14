/**
 * 验证 `PathSandbox` 的**边界**：绝对路径 / 跨盘 / UNC 必须被拒。
 *
 * ## 为什么单独写这个（2026-10-14 实机）
 *
 * `validateAndResolve()` 原来只有 `rel.startsWith('..')` 一道检查，而
 * `path.relative()` 在**跨盘**和 **UNC** 两种情形下会把**绝对路径原样返回**
 * （不以 `..` 开头）⇒ 检查被完全绕过，`read_file` 能读出根之外的文件。
 *
 * ⚠️ 关键是：**同盘**绝对路径（`C:\sandbox` + `C:\Windows\...`）反而**会被拦住**
 * （`relative` 返回 `..\Windows\...`）。所以只测同盘会得出"已经防住了"的错误结论 ——
 * 这正是这个 bug 能活下来的原因。**必须逐类覆盖**：
 *
 *   跨盘 (D: -> C:) | UNC (\\server\share) | POSIX 绝对 (/etc) | 相对穿越 (..\..)
 *
 * 用法：`bun run verify:path-sandbox`（退出码 0 = 全部符合预期）
 */
import { PathSandbox } from '../utils/path-sandbox'

type Expect = '拒' | '放'

const CASES: Array<[string, string, Expect, string]> = [
  ['D:\\sandbox', 'C:\\Windows\\win.ini', '拒', '跨盘绝对路径（原漏洞）'],
  ['C:\\sandbox', 'C:\\Windows\\win.ini', '拒', '同盘绝对路径'],
  ['C:\\sandbox', '\\\\server\\share\\x', '拒', 'UNC 路径（原漏洞）'],
  ['C:\\sandbox', '..\\..\\Windows\\win.ini', '拒', '相对穿越'],
  ['C:\\sandbox', '/etc/passwd', '拒', 'POSIX 绝对路径'],
  ['C:\\sandbox', 'sub\\file.txt', '放', '正常相对路径'],
  ['C:\\sandbox', 'a\\b\\c.txt', '放', '多层相对路径'],
  ['C:\\sandbox', '', '放', '空串 = 根自身'],
]

let failed = 0

console.log('base'.padEnd(14), 'target'.padEnd(26), '期望', '实际', ' 说明')
console.log('-'.repeat(78))

for (const [base, target, want, note] of CASES) {
  let got: Expect
  try {
    new PathSandbox(base).validateAndResolve(target)
    got = '放'
  } catch {
    got = '拒'
  }
  const ok = got === want
  if (!ok) failed++
  console.log(
    `${ok ? 'ok  ' : '!!  '}${base.padEnd(14)} ${target.padEnd(26)} ${want}   ${got}   ${note}`
  )
}

console.log()
if (failed > 0) {
  console.error(`✗ ${failed}/${CASES.length} 条不符合预期 —— 沙箱边界被破坏`)
  process.exit(1)
}
console.log(`✓ ${CASES.length}/${CASES.length} 条符合预期`)
