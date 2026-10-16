# rewrite-verify — baseline-vs-rewrite differential harness

**为什么需要它。** 本次重写要把「与上游逐字节相同」的文件改写成自有实现，同时
**行为逐字节不变**。仓库里已有 26 份差分夹具（`server-go/tools/parity/*_fixtures.json`）
可以作为大部分文件的验收标准，但**有一批文件它们覆盖不到**（见下）。
对这批文件，只有"把上游版本与改写版本并排跑、逐字节比输出"才能证明无损。

---

## 用法

```bash
# 需要 bun；路径按本机实际
BUN="C:/Users/LCGX/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe/bun-windows-x64/bun.exe"

"$BUN" tools/rewrite-verify/diff_gameplay.mjs      # gameplay getter 类
"$BUN" tools/rewrite-verify/diff_utils_units.mjs   # utils 纯函数类
```

原理（`diffharness.mjs`）：把文件在基线 `8311c9a` 的版本 checkout 到 shadow tree，
重写其相对 import 的深度使其可被同进程加载，然后把**上游版**与**改写版**并排 import，
喂同一份语料库与同一组输入，**逐字节比对渲染文本**。

---

## ★ 为什么不用那 26 份冻结夹具（覆盖缺口，实测）

| 文件 | 冻结夹具覆盖 | 说明 |
|---|---|---|
| `trace-troop-tree.ts` | ❌ **零覆盖** | `gen_gameplay_fixtures.mjs` 生成的 `entityCases` 只有 9 个 kind：`clan culture hero item kingdom perk policy settlement skill` —— **没有 `troop`** |
| `bannerlord-doctor.ts` | ❌ 无 | 依赖真实模块树 |
| `read-gauntlet-ui.ts` | ❌ 无 | 需要 sandbox XML 树 |
| `read-csharp-type.ts` | ❌ 无 | 需要 `csharp_types` 表 |
| `project-memory-*.ts`（5 个） | ❌ 无 | 需要 memory DB |

**⇒ 对这批文件，"夹具 diff 为空"这个判据不存在**，必须用本 harness。

---

## ★ 反向对照：证明这个 harness 不是恒真

**一个不可能失败的检查等于没有检查**（本项目已在别处栽过）。

实测：把 `get-skill-data.ts` 的一个字段 `+1`，harness **立刻报 3/5 case 不同**。
⇒ 它能检测到**一个 token 级**的改动，不是 vacuous pass。

**任何人改动本 harness 后，都应重跑一次这个对照**，确认它仍然会红。

---

## ⚠️ 两条会让人白干一天的约束

### 1. `buildFtsQuery` 的名字与函数体都不能动

`server-go/tools/parity/gen_fixtures.mjs` **按函数名整段抽取** `buildFtsQuery`
（花括号配对），且从 `search-docs.ts` 和 `search-api-docs.ts` **各抽一份并互相比对**
（不一致直接 FATAL）。所以：

- 可以动它**周围**的代码
- **不能**改它的函数名、签名、函数体

违反的后果不是测试失败，而是 `gen_fixtures.mjs` **抽取失败并 fatal** —— 看起来像环境坏了。

### 2. 路径写法：用 `D:\...` 反斜杠绝对路径

本机的文件写入工具**会把 `D:/...` 前缀当成相对 cwd 解析**，静默写到
`E:\d\GitHub\...`（cwd 是 `E:\Document`）。表现是"文件写成功了但仓库里没有"。

⇒ **一律用 `D:\GitHub\...`**。若怀疑踩过，检查 `E:\d` 是否存在。

---

## 边界

本目录**只做验证**，不产生仓库产物：

- 不改 `server-go/`（那是金标生成器）
- 不改 26 份冻结夹具
- 不为"通过"而调整语料 —— 若 diff 非空，先假设是**自己的改动破坏了行为**
