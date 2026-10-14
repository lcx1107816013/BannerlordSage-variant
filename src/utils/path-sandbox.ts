import { isAbsolute, relative, resolve } from 'node:path'
import { root } from './env'

export class PathSandbox {
  readonly #basePath: string

  constructor(basePath: string) {
    this.#basePath = isAbsolute(basePath) ? resolve(basePath) : resolve(root, basePath)
  }

  validateAndResolve(relativePath: string): string {
    // ★★ 2026-10-14：补**绝对路径**闸门。
    //
    // ## 缺陷形态（实测可复现）
    // 原来只有 `rel.startsWith('..')` 一道检查，而 `relative()` 在两种情形下
    // **返回的是它自己（一个绝对路径），不以 `..` 开头** ⇒ 检查被完全绕过：
    //   · **跨盘**：`relative("D:\\a\\b", "C:\\Windows\\win.ini")` -> `"C:\\Windows\\win.ini"`
    //   · **UNC** ：`relative("C:\\a", "\\\\server\\share\\x")`    -> `"\\\\server\\share\\x"`
    // ⇒ `read_file("C:\\Windows\\win.ini")` 能读出系统文件内容
    //   （该路径被 `src/tools/read-file.ts` 与 `list-directory.ts` 使用）。
    //
    // ## 为什么必须显式判，而不是靠 `resolve()`
    // `resolve(base, absolute)` **会丢弃 base** 直接返回那个绝对路径 ——
    // 所以 `fullPath` 从第一步就已经在根之外了，后面的 `relative` 只是没能报出来。
    //
    // ⚠️ 同盘绝对路径（`C:\sandbox` + `C:\Windows\...`）反而**会被拦住**
    //    （`relative` 返回 `..\Windows\...`），所以只测同盘会误以为"已防住"。
    //    实测证据见 `tests/probe_sandbox_fix.mjs`（在 bannerlord-mcp-suite 仓库）。
    if (isAbsolute(relativePath)) {
      throw new Error(`Path escapes the sandbox root: "${relativePath}"`)
    }

    const fullPath = resolve(this.#basePath, relativePath)
    const rel = relative(this.#basePath, fullPath)

    if (rel.startsWith('..') || isAbsolute(rel)) {
      // `isAbsolute(rel)` 是第二道（纵深）：即使将来有人把上面那道去掉，
      // 跨盘/UNC 也会在这里被挡住 —— 因为它们让 `relative` 返回绝对路径。
      throw new Error(`Path escapes the sandbox root: "${relativePath}"`)
    }

    return fullPath
  }

  get basePath(): string {
    return this.#basePath
  }
}
