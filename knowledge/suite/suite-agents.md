# AGENTS.md — 给 AI 的安装指南（bannerlord-mcp-suite）

> **这是给 AI coding agent 看的**。目标：**傻瓜化地把四个 MCP 装好** ——
> 该登记的登记成 MCP、该放进 `Modules\` 的放进去。
>
> 人也可以读，但本文件默认"执行者是一个能跑命令、能读写文件的 AI"。
>
> ⚠️ **先读 §0 的分工**：**四个 MCP 里只有一个需要放进游戏 `Modules\`**，其余三个**都不放**。
> 这是最容易搞错的一步。

---

## 0. ★ 先分清：四个 MCP 各自要做什么（**别一刀切**）

| # | 仓库 | 形态 | **要放进 `Modules\` 吗** | MCP 怎么起 | 前置 |
|---|---|---|---|---|---|
| 1 | [`Bannerlord-blbridge`](https://github.com/lcx1107816013/Bannerlord-blbridge) | **C# DLL + Python MCP** | ✅ **要**（`Modules\BlBridge\`） | `python bl_mcp.py`（stdio） | VS Build Tools 或 .NET SDK（编译用）；Python 3.8+ |
| 2 | [`BannerlordSage-variant`](https://github.com/lcx1107816013/BannerlordSage-variant) | TypeScript | ❌ **不要** | `bun run src/entrypoints/bannerlord-stdio.ts` | bun、ripgrep、.NET SDK 8+、ILSpyCmd |
| 3 | [`Bannerlord-Helper-variant`](https://github.com/lcx1107816013/Bannerlord-Helper-variant) | TypeScript | ❌ **不要** | `bun run mcp/server.ts` | bun、Node 18+（可选，跑 CLI 用） |
| 4 | **本仓库** `bannerlord-mcp-suite` | Python | ❌ **不要** | `python bl_chain.py`（stdio） | Python 3.8+，**零第三方依赖** |

★ **一句话**：**只有 BlBridge 是"游戏 mod"**（要进 `Modules\`）；
其余三个都是**外部 MCP 服务**，只要能被客户端 spawn 起来即可。

### 0.1 ★★ 怎么**机械判定**"某个仓库要不要进 `Modules\`"（唯一硬判据）

**判据：它有没有自己的 `SubModule.xml`。**
游戏**只认 `SubModule.xml`** 当 mod —— 没有它，放进 `Modules\` 也**不会被加载**。

| 仓库 | 有没有**自己的** `SubModule.xml` | 判定 |
|---|---|---|
| `Bannerlord-blbridge` | ✅ `module/SubModule.xml`（`<Id>BlBridge</Id>`、`<Name>BlBridge Telemetry</Name>`） | **进 `Modules\`** |
| `BannerlordSage-variant` | ❌ **没有** | **不进** |
| `Bannerlord-Helper-variant` | ❌ **没有** | **不进** |
| `bannerlord-mcp-suite`（本仓库） | ❌ **没有** | **不进** |

⚠️ **一个会让这个判据误判的陷阱**（实测踩过）：
在 Sage 仓库里 `grep SubModule.xml` 会命中 **9 个**，全在
`dist/games/bannerlord/assets/Xmls/Modules/<模块名>/SubModule.xml`。
**那些不是 Sage 的 mod 清单**，而是它**索引时从游戏里抄来的副本** ——
证据：与游戏原生那份 **SHA256 逐字节相同**。
⇒ **判据要收紧成"是不是它自己的 `SubModule.xml`"**（在仓库根/`module/` 下，且 `<Id>` 是它自己）。
⇒ Sage 因此**不是 mod**。

### 0.2 ★ 部署后「一个 mod + 一个 MCP」在磁盘上长什么样

你说得对 —— **BlBridge 是"一个 mod 里同时含 MCP"**。部署后实际结构：

```
<游戏根>\Modules\BlBridge\
├── SubModule.xml        ← ★ 那个 mod 清单（游戏读它才知道有这 mod）
├── bin\                 ← 编译产物 BlBridge.dll
├── ModuleData\          ← mod 数据
├── build_manifest.json  ← 构建身份（外部可核验"进程里跑的是哪份 DLL"）
└── mcp\                 ← ★ 那个 MCP（bl_mcp.py + manifest.json + README + AI-TUTORIAL）
```

★ 所以 BlBridge **一份目录同时满足两个身份**：对游戏它是 mod，对 AI 它是 MCP 服务器。
**其余三个没有 mod 身份**，只作为 MCP 服务被客户端 spawn。

★ **但建议你只挂 `bl_chain`（第 4 个）** —— 它会把 1/2/3 当成子进程自己起起来。
**不要**把 1/2/3 与 `chain` 同时挂进同一个客户端（那会让同一能力出现两个入口，
且每个上游跑两份进程）。见 §4。

---

## 1. 第 1 步：clone 四个仓库

```bash
git clone https://github.com/lcx1107816013/bannerlord-mcp-suite.git
git clone https://github.com/lcx1107816013/Bannerlord-blbridge.git
git clone https://github.com/lcx1107816013/BannerlordSage-variant.git
git clone https://github.com/lcx1107816013/Bannerlord-Helper-variant.git
```

（放哪都行 —— 全链路**不硬编码路径**，用环境变量指过去即可。）

---

## 2. 第 2 步：装前置

| 前置 | 谁需要 | 怎么装 | 验证 |
|---|---|---|---|
| **Python 3.8+** | 伞仓 + BlBridge 的 MCP | 系统安装 | `python --version` |
| **bun** | Sage + Helper | https://bun.sh | `bun --version` |
| **VS Build Tools 或 .NET SDK** | 只有**编译** BlBridge 需要 | 见下方 §3.1 | `dotnet --version` |
| **ripgrep**（`rg`） | 只有 Sage 需要 | `winget install BurntSushi.ripgrep.MSVC` | `rg --version` |
| **ILSpyCmd** | 只有 Sage 需要 | `dotnet tool install -g ilspycmd` | `ilspycmd --version` |
| **Node 18+** | Helper 的 **CLI**（可选） | https://nodejs.org | `node --version` |

★ **不确定缺什么**：跑伞仓的 `pwsh -File bootstrap.ps1 -Check` ——
它会**逐个点名**，并**打印该执行的 `git clone` / 该设的环境变量**。

---

## 3. 第 3 步：四个 MCP 各自装好

### 3.1 BlBridge（★ **唯一要放进 `Modules\` 的**）

**A. 编译 + 部署（把 DLL 与 MCP 包放进游戏目录）**

```powershell
cd <你 clone 的>\Bannerlord-blbridge
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Deploy
#   -Deploy 会把 DLL + ModuleData + mcp\ 整份复制进
#   <游戏根>\Modules\BlBridge\
#   GameDir 默认是本机 Steam 路径；不同就传 -GameDir "<你的游戏根>"
```

**B. 让游戏加载它**

启动器勾选 **BlBridge**（`Modules\BlBridge\SubModule.xml` 的 `<Id>`）→ 启动游戏。

**C. ★ 判定"真的加载了"（唯一硬判据）**

```powershell
python <游戏根>\Modules\BlBridge\mcp\bl_cmd.py status
#   返回 state=idle|loading|running|ended  ⇒ 控制通道通了
```

**D. 登记成 MCP（两种方式任一）**

```powershell
# 方式一：跑自带脚本（幂等、会先备份）
python <游戏根>\Modules\BlBridge\mcp\register_mcp.py

# 方式二：手写配置（见 §4 的 JSON 模板）
```

★ **完整教程**（含 JSONL 事件格式、常见报错归因、最短上手闭环）：
`<游戏根>\Modules\BlBridge\mcp\AI-TUTORIAL.md` —— **那个文件比我这里详细，优先看它**。

⚠️ **两个高频坑**（AI-TUTORIAL 里也有）：
1. **`bl_open_ui` 只在主菜单可用** —— 已加载 Game 时调它会让状态栈卡在 `GameLoadingState`。
   顺序永远是 `close_ui`（回主菜单）→ `open_ui`。
2. **参数名是 `uiId`，不是 `id`** —— 请求信封自带 `id`，用 `id` 传参会被顶掉。

### 3.2 BannerlordSage-variant（**不要放进 `Modules\`**）

```bash
cd <你 clone 的>\BannerlordSage-variant
bun install
bun run setup:bannerlord -- --game-dir "<你的游戏根>"
#   ↑ 会索引本地反编译源码 / XML + 官方与社区文档
#   离线环境加 --skip-docs
```

★ 该仓库自带 **`AGENTS.md`**（`Standard Human Install Flow` / `MCP Client Config` 两节）——
**它的说明比我这里权威**，冲突时以它为准。

### 3.3 Bannerlord-Helper-variant（**不要放进 `Modules\`**）

```bash
cd <你 clone 的>\Bannerlord-Helper-variant
bun install
#   MCP 服务器直接由 bun 起（见 §4），不需要额外构建
```

**若要它的 CLI**（`bh` 命令）：

```bash
npm install bannerlord-helper --global     # 或：bun add -g bannerlord-helper
```

⚠️ **它的 Nexus 检索需要 key**，且**只从环境变量读**：

```
NEXUS_API_KEY=<你的 key>      # 或 NEXUSMODS_API_KEY
```

不给也能跑，但那两个 Nexus 工具会返回明确报错（**会告诉你去哪申请**）。

### 3.4 本仓库（伞仓，**不要放进 `Modules\`**）

```bash
cd <你 clone 的>\bannerlord-mcp-suite
python bl_chain.py --selftest      # 缺哪个上游会点名
```

★ 无需 `pip install` —— **零第三方依赖**。

---

## 4. 第 4 步：接进 MCP 客户端（**推荐只挂 `chain` 一个**）

### 4.1 ★ 推荐形态：只挂伞仓，由它内部起那三个

```jsonc
{
  "mcpServers": {
    "chain": {
      "command": "python",
      "args": ["<你 clone 的>/bannerlord-mcp-suite/bl_chain.py"],
      "env": {
        "DSH_CHAIN_MODE": "meta",                                  // ★ 省 token 的关键
        "DSH_CHAIN_BLBRIDGE": "<你 clone 的>/Bannerlord-blbridge",
        "DSH_CHAIN_SAGE":     "<你 clone 的>/BannerlordSage-variant",
        "DSH_CHAIN_HELPER":   "<你 clone 的>/Bannerlord-Helper-variant",
        "BANNERLORD_DIR":     "<你的游戏根>",
        "DSH_CHAIN_BUN":      "<bun 可执行文件路径>",
        "NEXUS_API_KEY":      "<可选>"
      }
    }
  }
}
```

- `DSH_CHAIN_MODE=meta` ⇒ 常驻只 **5 个元工具 / 604 真实 token**（全量 115 个 / 31,399）
  ★ 本文件的数字由 `python tests/check_doc_numbers.py` 守着，改前先重跑 `--measure`
- 三步用法：`chain_search_tools` 找 → `chain_get_tool_details` 看参数 → `chain_call_tool` 调
- **也可直呼原名**（不必先检索）

### 4.2 备选：只挂其中几个（不想要太多工具时）

```jsonc
"env": { "DSH_CHAIN_SERVERS": "bannerlordsage,bannerlordhelper" }   // 只托管这两个
```

★ 这时**别再把这两个单独挂**（否则重复）。

### 4.3 ⚠️ 不要四个 + chain 一起挂

那会让**同一能力出现两个入口**（`mcp__blbridge__bl_status` 与 `mcp__chain__bl_status`），
且**每个上游跑两份进程**。要统一就走 §4.1。

### 4.4 装完自查

```bash
python <伞仓>/bl_chain.py --selftest        # 四个上游是否都连上
# 或在客户端里调 chain_status（会列出每个上游的 connected / 工具数 / 当前模式成本）
```

---

## 5. 一套「从零到能跑」的最短闭环（复制粘贴级）

```powershell
# ── ① clone ──────────────────────────────────────────────────────────
cd <一个你放项目的目录>
git clone https://github.com/lcx1107816013/bannerlord-mcp-suite.git
git clone https://github.com/lcx1107816013/Bannerlord-blbridge.git
git clone https://github.com/lcx1107816013/BannerlordSage-variant.git
git clone https://github.com/lcx1107816013/Bannerlord-Helper-variant.git

# ── ② 前置（按需）────────────────────────────────────────────────────
python --version ; bun --version ; dotnet --version
dotnet tool install -g ilspycmd

# ── ③ BlBridge：编译 + 部署进 Modules\（★ 只有它要进）───────────────
cd Bannerlord-blbridge
powershell -ExecutionPolicy Bypass -File .\build.ps1 -Deploy -GameDir "<你的游戏根>"
cd ..

# ── ④ Sage：装依赖 + 索引 ────────────────────────────────────────────
cd BannerlordSage-variant
bun install
bun run setup:bannerlord -- --game-dir "<你的游戏根>"
cd ..

# ── ⑤ Helper：装依赖 ─────────────────────────────────────────────────
cd Bannerlord-Helper-variant
bun install
cd ..

# ── ⑥ 环境探测（会点名缺什么 + 打印该执行的命令）────────────────────
cd bannerlord-mcp-suite
pwsh -File bootstrap.ps1 -Check

# ── ⑦ 桥自检（四个上游是否都连上）───────────────────────────────────
python bl_chain.py --selftest
```

**然后在客户端里按 §4.1 挂 `chain`**，调 `chain_status` 确认四个上游 `connected: true`。

---

## 6. 装完的验收清单（每条都可机械判定）

| # | 判据 | 怎么验 |
|---|---|---|
| 1 | 四个仓库都在本地 | `bootstrap.ps1 -Check` 四项全 `[ok]` |
| 2 | BlBridge 在 `Modules\` 里 | `<游戏根>\Modules\BlBridge\SubModule.xml` 存在 |
| 3 | BlBridge 被游戏加载 | `bl_cmd.py status` 返回 `state=...`（不是报错） |
| 4 | Sage 索引建好了 | `bun run start:bannerlord` 能起来、`bannerlord_index_status` 有数字 |
| 5 | Helper 能起 | `bun run mcp/server.ts` 不报缺依赖 |
| 6 | 桥能连上四个上游 | `python bl_chain.py --selftest` 通过 / `chain_status` 全 `connected` |
| 7 | 客户端看得见工具 | 客户端里 `chain_search_tools` 能返回结果 |
| 8 | **没有重复挂载** | 客户端里**没有**同时挂 `blbridge`+`chain` 之类 |

---

## 7. 常见失败与归因（**照着查，别猜**）

| 症状 | 最可能的原因 | 处置 |
|---|---|---|
| `bootstrap.ps1` 报某仓库 `[MISS]` | 没 clone，或没设 `DSH_CHAIN_*` | 按它打印的 `git clone` 命令补；再设环境变量 |
| `bl_chain.py --selftest` 某上游 `connected: false` | 路径错 / bun 没装 / BlBridge 没部署 | 看它给的 `error` 字段，对症 |
| BlBridge 工具报 `wrong_state` | 没停在官方自定义战斗界面 | `bl_open_ui` 进去；⚠️ **只在主菜单可用** |
| BlBridge 报 `unknown_troop` | 兵种数据还没加载 | 先 `bl_open_ui` 停到 `CustomBattleState` 再 `bl_start_battle` |
| `bl_status` 说 `game_not_restarted` | 部署了新 DLL 但游戏没重启 | 重启游戏（DLL 只在启动时加载） |
| 状态栈卡在 `GameLoadingState` | 在非主菜单调了 `open_ui` | 重启游戏；此后严格 `close_ui` → `open_ui` |
| Sage 报缺 `ilspycmd` | 没装 ILSpyCmd | `dotnet tool install -g ilspycmd` |
| Helper 的 Nexus 工具报缺 key | 没设 `NEXUS_API_KEY` | 设环境变量；报错里带申请地址 |
| 同一工具在客户端出现两次 | 同时挂了单服务器与 `chain` | 见 §4.3，只留 `chain` |

---

## 8. 卸载 / 回退（都很干净）

| 要回退什么 | 怎么做 |
|---|---|
| BlBridge 的 mod | 删 `<游戏根>\Modules\BlBridge\` 整个目录（**这是它的设计原则：删掉即完全回退**） |
| BlBridge 的 MCP 登记 | `python ...\mcp\register_mcp.py --remove` |
| 伞仓 / Sage / Helper | 删目录 + 从客户端配置里去掉 `chain` 条目 |
| Sage 的索引 | 删它的 `dist/`（可重建：重跑 `setup:bannerlord`） |

★ **四个 MCP 都不写系统注册表、不装服务、不开端口** ——
所以卸载就是**删目录 + 删配置**，不需要"卸载程序"。

---

## 9. 相关文档（**冲突时以谁为准**）

| 文档 | 讲什么 | 权威性 |
|---|---|---|
| **本文件** | ★ **四个一起装的编排**（跨仓库） | 本仓库维护 |
| [`README.md`](README.md) | 桥是什么、四种模式、各仓库地址 | 本仓库维护 |
| [`docs/why-umbrella-repo.md`](docs/why-umbrella-repo.md) | 为什么是伞仓、为什么不 vendor | 本仓库维护 |
| `Bannerlord-blbridge/module/mcp/AI-TUTORIAL.md` | ★ **BlBridge 装 + 用**的完整教程 | **该仓库权威** |
| `BannerlordSage-variant/AGENTS.md` | ★ **Sage 装 + MCP 配置**的完整说明 | **该仓库权威** |
| `Bannerlord-Helper-variant/AGENTS.md` | ★ **Helper 装 + MCP 接入**（含"哪两个工具会写盘"） | **该仓库权威** |

★ **原则**：**各仓库自己的文档对它自己最权威**；本文件只负责**把它们串起来**。
若本文件与某仓库自己的文档冲突，**以那个仓库的为准**，并请提 issue 让本文件改正。

### 9.1 四个仓库的「给 AI 看的文档」现状（实测）

| 仓库 | AI 文档 | 是否覆盖"怎么装" |
|---|---|---|
| `bannerlord-mcp-suite` | **本文件** `AGENTS.md` | ✅ 跨仓库编排 |
| `Bannerlord-blbridge` | `AGENTS.md` + `module/mcp/AI-TUTORIAL.md` | ✅（AI-TUTORIAL 最详） |
| `BannerlordSage-variant` | `AGENTS.md`（含 `Standard Human Install Flow`） | ✅ |
| `Bannerlord-Helper-variant` | **`AGENTS.md`**（本次新增） | ✅ |
