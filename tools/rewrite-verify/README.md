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
"$BUN" tools/rewrite-verify/diff_tools.mjs         # list/read/file 与 6 个 mod-source 包装
"$BUN" tools/rewrite-verify/diff_utils_units.mjs   # utils 纯函数类
```

原理（`diffharness.mjs`）：把文件在基线 `8311c9a` 的版本 checkout 到 shadow tree，
重写其相对 import 的深度使其可被同进程加载，然后把**上游版**与**改写版**并排 import，
喂同一份语料库与同一组输入，**逐字节比对渲染文本**。

两个 runner 任何 case 不等都会以非零码退出。

---

## ★ 为什么不用那 26 份冻结夹具（覆盖缺口，实测）

| 文件 | 冻结夹具覆盖 | 说明 |
|---|---|---|
| `trace-troop-tree.ts` | ❌ **零覆盖** | `gen_gameplay_fixtures.mjs` 生成的 `entityCases` 只有 9 个 kind：`clan culture hero item kingdom perk policy settlement skill` —— **没有 `troop`** |
| `bannerlord-doctor.ts` | ❌ 无 | 依赖真实模块树 |
| `read-gauntlet-ui.ts` | ❌ 无 | 需要 sandbox XML 树 |
| `read-csharp-type.ts` | ❌ 无 | 需要 `csharp_types` 表 |
| `project-memory-*.ts`（5 个） | ❌ 无 | 需要 memory DB |
| `list-mod-directory.ts` | ⚠️ 仅间接 | `gen_modsourceindex_fixtures.mjs` 只驱动 **facade**（`utils/local-mod-csharp-index.ts`）与 `search-mod-source.ts`，从不经过这两个入口 |
| `read-mod-file.ts` | ⚠️ 仅间接 | 同上 |
| `index-mod-source.ts` | ⚠️ 仅间接 | 该生成器 mock 的是 **script**（`src/scripts/index-mod-source.ts`），不是这个包装 |
| `mod-source-status.ts` | ⚠️ 仅间接 | 同上 |
| `read-mod-type.ts` | ⚠️ 仅间接 | 同上 |

**⇒ 对这批文件，"夹具 diff 为空"这个判据不存在**，必须用本 harness。

---

## ★ 反向对照：证明这个 harness 不是恒真

**一个不可能失败的检查等于没有检查**（本项目已在别处栽过）。

实测：把 `get-skill-data.ts` 的一个字段 `+1`，harness **立刻报 3/5 case 不同**。
⇒ 它能检测到**一个 token 级**的改动，不是 vacuous pass。

**任何人改动本 harness 后，都应重跑一次这个对照**，确认它仍然会红。

追加的两条实测（batch 3）：

| 改什么 | 报什么 |
|---|---|
| `list-directory.ts` 去掉目录的尾部斜杠 | 1/5 case 不同 |
| `mod-source-sandbox.ts` 把 sandbox 根改成 `sourceDir + '/src'` | 3 个文件分歧（`list-mod-directory`、`read-mod-file`、`search-mod-source`） |

---

## ★★ 两个必须知道的陷阱（都是走进去才学到的）

### 陷阱 1：恒真通过 —— 两边抛同一个错，比较也"相等"

`read-mod-type.ts` 的第一版 runner **每个 case 都通过，且什么都没证明**：
所有输入都让两边抛出**完全相同的内部错误**，于是"逐字节相同"被一个与改写无关的
错误串满足了。

修法：case 可以标 `expectThrow: true`，表示**这个输入下工具自身的报错就是可观察输出**
（文件不存在、沙箱逃逸）。这些是**对错误文案的真实比较**。
其余所有"两边都抛"计入 **unexpected throw**，并作为 caveat 打在 OK 行上：

```
OK    src/tools/list-directory.ts  (5 cases, ... [3/5 error-path cases (message compared)])
OK    src/tools/foo.ts             (5 cases, ... [★ 3/5 UNEXPECTED both-side throws — proves nothing])
```

**OK 行上出现非零的 unexpected throw 数 = runner 有缺陷，不是通过。**
它意味着这些 case 必须补上缺失的依赖后重跑。

### 陷阱 2：手算的路径 ≠ 解析出来的路径

`mod-workspace.mjs` 一开始自己算 workspace id。该 hash 取自**解析后**的 source root，
而手算的值把 `readLocalModType` 指到一个不存在的库，报错是
`Cannot open an anonymous database in read-only mode`。
现在该模块调用**真实的** `resolveModSourceWorkspace`，直接用它的
`sourceRoot` / `cacheRoot` / `dbPath`，因此不可能与受测代码漂移。

顺带：`dbPath` 是**挂在 `workspace` 对象上**的，不是并列字段。
`readLocalModType` 打开的是 `workspace.dbPath`；注入的 summary 漏了它就报同一个
"anonymous database" 错。

### 陷阱 3：语料库自己的构造 bug —— 全绿，且每个 case 都在测 `undefined`

**这一类最危险**，因为它不报错、不抛异常、OK 行漂亮，而**所有 case 根本没碰到被测代码**。

`diff_utils_units.mjs` 的 render 语料第一版写成这样：

```js
const renderCorpus = [
    [{}, []],                                    // ← [第一个 block, topFields]
    [{ header: 'h' }, [{ key: 'top', value: 'x' }]],
]
for (const [blocks, topFields] of renderCorpus) {
    await run(..., side => renderCase(side, blocks, topFields))
}
```

`for (const [blocks, topFields] of ...)` 是**解构元组**。于是 `blocks` 拿到的是
`{}`（一个**对象**，不是数组），`renderAiTextReport` 在它上面调 `.forEach`：

```
TypeError: blocks.forEach is not a function
```

**两边抛同一个错 ⇒ 比较"相等" ⇒ 全绿。** 这与陷阱 1 同源（恒真通过），但成因不同：
陷阱 1 是输入本身就走错误路径，这里是**harness 自己的代码写错了**。

暴露它的是**反向验证**：给 `ai-text.ts` 注入一个必然可观察的变异
（把多行字段的空判定从 trim 后的文本改回原始值），harness **仍然全绿** ——
一个必然可观察的 bug 无法被抓到，只可能是这个 case 没真跑。

修法是把语料改成**带名字的对象**，让结构错误在编译期/阅读期就可见：

```js
const renderCorpus = [
    { label: 'no blocks', blocks: [], topFields: [] },
    { label: '…', blocks: [{ header: 'h' }], topFields: [{ key: 'top', value: 'x' }] },
]
for (const entry of renderCorpus) {
    await run(`renderAiTextReport(${entry.label})`, side => renderCase(side, entry.blocks, entry.topFields))
}
```

> **判据**：**一个必然可观察的变异没被抓到 = 先怀疑 harness，不要怀疑变异。**
> 这条也是"不能删掉存活变异"的理由 —— 上面这个 case 里，那两条存活变异恰好是
> harness 唯一的报警信号。删掉它们，"0 存活"就会盖住一个**完全失效**的语料库。

### 陷阱 4：语料库"看着覆盖了"，其实缺了能区分的那个输入

反向验证里另外两条存活，**不是** harness 的 bug，而是**语料库的覆盖缺口**，
两条都是靠"注入必然可观察的变异却全绿"才发现的：

| 存活变异 | 缺口 | 补上的输入 |
|---|---|---|
| `if (!body)` → `if (!field.value)`（多行字段用**原始值**判空） | 语料只有 `''` 与 `null` —— 两者**两种写法都为假**，区分不出来 | 纯空白值：`'   '`、`'\t\n '`、`'\u00a0'`、`'\ufeff'` |
| `resolveEffectiveSourceRoot` 的"根本身就叫 `src`"规则 → 关闭 | 语料里的树**要么**根叫 `src`、**要么**有嵌套 `src`，两条规则返回同一个答案 | 一棵**既叫 `src` 又含嵌套 `src`** 的树 |

> 反过来说：**存活变异必须先假设"我的语料库漏了"，只有当枚举证明不存在反例时才写 EQUIVALENT。
> 上面那两条我一开始都以为是等价变异，枚举之后发现都是真缺口。**

---

## ★ 等价变异的记录方式（不许删）

`mutations.sh` 会注入若干缺陷并断言 harness 变红。其中有 3 条**判为等价**，
它们**保留在列表里、显式打印 EQUIVALENT 并附枚举论证**，而不是删掉：

| 等价变异 | 枚举论证 |
|---|---|
| `env`: `activeGameId` 改成重新读环境变量 | 没有消费方在 import 之后改 `BANNERSAGE_GAME` |
| `ai-text`: 布尔分支写成 `v && 'a' \|\| 'b'` | 该分支被 `typeof value === 'boolean'` 守住，定义域恰好是 `{true,false}`，两种写法在域内一致 |
| `entity-resolver`: `find` → `findLast` | harness **自己断言**没有任何调用点传入"互为前缀"的 prefix 集合；该断言一旦失效 harness 立刻报错 |

**为什么不能删**：删掉存活变异会让"0 存活"变成**误导数字** ——
那个数字会被当成证据。这是本项目已经栽过的坑（见 `server-go/tools/parity/README.md`）。

第三条尤其值得抄：**把"为什么不构成差异"变成一个 harness 里的断言**，
等价性就不会随代码演进而静默失效。


### 关于 indexer 的 mock

`ensureLocalModSourceIndex` 会跑 Roslyn indexer（`dotnet build` + `run`）。
那条流水线本机不可用，而且它自己会因为 `src/scripts/index-csharp.ts` 里一个未定义的
`$indexedAt` 而抛错 —— 那是**本阶段范围外、既有的 bug**（本阶段只改结构，不修 bug）。
放任不管，则每个 case 都会两边同抛。

`mock.module` 注入一个指向 `mod-workspace.mjs` 自建工作区的 summary，于是 facade 与各包装
都在真实文件上跑真实代码，而 dotnet 不参与。这与 `gen_modsourceindex_fixtures.mjs`、
`gen_searchapidocs_fixtures.mjs` 已在用的注入手法一致。

---

## ⚠️ 两条会让人白干一天的约束

### 1. `buildFtsQuery` 的名字与函数体都不能动

`server-go/tools/parity/gen_fixtures.mjs` **按函数名整段抽取** `buildFtsQuery`
（花括号配对），且从 `search-docs.ts` 和 `search-api-docs.ts` **各抽一份并互相比对**
（不一致直接 FATAL）。所以：

- 可以动它**周围**的代码
- **不能**改它的函数名、签名、函数体

违反的后果不是测试失败，而是 `gen_fixtures.mjs` **抽取失败并 fatal** —— 看起来像环境坏了。

验证方式：

```bash
bun run server-go/tools/parity/gen_fixtures.mjs
git diff --stat server-go/tools/parity/fixtures.json   # 必须为空
```

注意 `search-xml.ts` 里也有一个私有的 `buildFtsQuery`，但**没有**生成器抽取它。

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

### 草稿语料的位置

`diff_tools.mjs` 自建的语料在 `tools/rewrite-verify/.tmp/`（已 gitignore），
**不写进 `server-go/`**。

### `restore-modsource-fixture-db.mjs` 为什么存在 —— **已过时**

> **现状：该生成器已修（`12933ab`），本脚本成为历史记录，不再需要。**
> 生成器现在 **CREATE 在前、DELETE 在后**，因此在新克隆上也能自足运行：
> ```bash
> rm -rf dist/mod-sources && bun server-go/tools/parity/gen_modsourceindex_fixtures.mjs
> # exit 0，9 cases，与金标逐字节相同；连跑两次幂等
> ```
> 该脚本保留在磁盘上是为了留下下面这段推理，**不应再被引用**。

`gen_modsourceindex_fixtures.mjs` 原先是先 `DELETE` 三张表、之后才 `CREATE` 它们，
所以它**依赖这三张表已经存在**于 `dist/mod-sources/<id>/mod-source.db`。
那条路径被 `.gitignore` 整目录排除（`*.db` 的取反只覆盖
`server-go/tools/parity/fixtures/*.db`），是**纯本地状态**，新克隆上并不存在；
在新克隆上该生成器死在第一个 `DELETE`（`no such table: csharp_types`）。

**这条缺陷由两个 teammate 从不同角度独立撞到**（一个走 `src/utils` 的重写验证，
一个走 `src/tools`），基线 `8311c9a` 上同样复现 —— 独立复现两次说明它是真问题。


---

## runner 一览

| Runner | 覆盖 | case 数 |
|---|---|---|
| `diff_gameplay.mjs` | 十个 gameplay getter（对着 `bannerlord-fixture-gameplay` 库） | 51 |
| `diff_tools.mjs` | `list-directory`、`read-file`、6 个 mod-source 包装 | 40 |
| `diff_utils_units.mjs` | 14 个 `src/utils` 单元的导出面（纯函数 + 需要 db 的部分） | 196 值 |
| `mutations.sh` | **反向验证**：注入 16 个缺陷，断言上面这个 runner 变红 | 16 注入 |

每个 case 都对**两个版本**各跑一次。

`diff_utils_units.mjs` 与另外两个的差别：它不重写 import 深度，而是把基线整棵树
`git archive` 到 `D:/Documents/_workutils/base`，**两份独立 checkout 并排 import**。
它比对 196 个**返回值**而非渲染文本，并且带两条**自断言**：

- 语料库里必须存在"互为前缀"的 prefix 集合，否则 `find`/`findLast` 的等价性主张不成立（会 FAIL）
- `undefined` 与 `null` 在序列化前**分开记法**，因为"字段缺失"与"字段为 null"是两种输出

配套：`inject.mjs` 单点替换注入器；`which_workspace.mjs` 回答
"`dist/mod-sources/<id>` 这个缓存目录归哪个 source root 所有" ——
在动手清理任何缓存之前先跑它，避免命中真实索引路径（见 `server-go/tools/parity/README.md` F19）。

