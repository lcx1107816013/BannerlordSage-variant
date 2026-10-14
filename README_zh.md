# Bannerlord-Blore

[![Bannerlord](https://img.shields.io/badge/Game-Bannerlord_II-8B0000?style=flat&logo=target)](https://www.taleworlds.com/en/Games/Bannerlord)
[![ILSpy](https://img.shields.io/badge/Tool-ILSpy-blue?style=flat&logo=c-sharp)](https://github.com/icsharpcode/ILSpy)
[![bun](https://img.shields.io/badge/Bun-%23000000.svg?style=flat&logo=bun&logoColor=white)](https://bun.com/)
[![ripgrep](https://img.shields.io/badge/ripgrep-%23000000.svg?style=flat&logo=rust&logoColor=white)](https://github.com/BurntSushi/ripgrep)

[English](./README.md) | [简体中文](./README_zh.md)

> ℹ️ **Bannerlord-Blore** —— 我们自己的骑砍 MCP 服务器（MCP 名 `blore`），
> 起源是 [`hby7921/BannerlordSage`](https://github.com/hby7921/BannerlordSage)（MIT）的非官方变种。
>
> 本仓库在上游基础上做了改动，**改动清单与理由见 [`NOTICE`](./NOTICE)**。
>
> **我们不声称与上游有任何隶属或背书关系**；上游版权与许可原文保留在
> [`LICENSE`](./LICENSE)（含「Upstream notice」段）。
>
> 相对上游的主要改动（详情见 `NOTICE`）：
> - **自有知识库**：默认知识层改为仓库内 `knowledge/` 语料（自研 modding 实战知识 + MCP suite 文档）；外部网页文档（官方教程、BannerlordModding.LT、apidoc.bannerlord.com）改为可选项，需 `bun run index:docs` / `--reindex-docs` 才抓取
> - 工具面收敛为 **30 个**（走分发型工具；上游注册了 **37** 个，且 `src/tools/` 里有 16 个**从未被注册**的文件，已移除其 import）
> - 已同步上游至 `eb05ae9`（实验性本地编辑器 MCP 预览已并入；5 个动作工具仅进 `full` 档）
> - 修 **Vortex 符号链接**导致的 `bannerlord_doctor` 假阳性（**39 → 0**；DLL 数 1 → 130）
> - 补 `.gitignore` 的 `.bak` 规则
>
> ★ 本仓库**保留上游 remote（`upstream`）**，以便继续跟进上游更新。

一个提供《骑马与砍杀2：霸主》源代码搜索和数据浏览功能的 MCP 服务器。

它读取你本机的 Bannerlord 安装目录，导入 XML，反编译官方 DLL，建立 SQLite 索引，并通过 MCP 工具暴露给 AI coding agent 使用。适用场景：

- Mod 开发
- 逆向分析
- 结构化玩法查询
- 读取本地 Mod 源码

## 用 AI 完成安装

如果你想直接把仓库扔给 Codex、Claude、Gemini、Copilot 等 coding agent 来帮你安装配置，按这个流程：

1. 把仓库地址发给 AI
2. 让它先读 `AGENTS.md`
3. 再让它按 `AI_QUICKSTART.md` 执行安装
4. 当它询问时，提供你的 `<BANNERLORD_GAME_DIR>`

## Attribution

BannerlordSage 包含基于 Vortex 的 RimSage 演化而来的工作。
项目继续使用 MIT License，详见 [`LICENSE`](./LICENSE)。

## 工具总览

BannerlordSage 共提供 **30 个工具**，分两个入口：

| 入口 | 工具数 | 说明 |
|------|--------|------|
| `bun run start:bannerlord` | 23 | 默认工具集，适合查询、分析、本地 mod 工作和项目记忆 |
| `bun run start:bannerlord:full` | 30 | 额外提供工作区创建、XSLT Patch 生成和实验性编辑器预览 |

基本使用流程：**运行 setup → 启动 MCP → 让模型调用工具**

## 工具列表

### 运行与诊断

| 工具 | 功能说明 |
|------|----------|
| `bannerlord_doctor` | 检查本地 Bannerlord 安装的模块健康状况：依赖缺失、重复 DLL、加载顺序异常等 |
| `bannerlord_index_status` | 查看 BannerlordSage 当前是否初始化完成、本地索引是否可用 |

### 项目记忆

| 工具 | 功能说明 |
|------|----------|
| `project_memory_read` | 读记忆：`action=search`（全文检索）、`recent`（最近条目）、`wakeup`（会话开始加载高优先级记忆） |
| `project_memory_write` | 写记忆：`action=add`（存一条）、`capture_session`（批量保存会话结论）、`invalidate`（标记失效） |

### 官方源码与 XML

| 工具 | 功能说明 |
|------|----------|
| `search_source` | 在官方反编译源码中全文搜索，不知道东西在哪个文件时用这个 |
| `read_csharp_type` | 已知 C# 类型名时，直接读取该类型的反编译定义 |
| `read_file` | 已知文件路径时，读取指定行范围的内容 |
| `list_directory` | 浏览已导入的官方资源目录结构 |
| `search_xml` | 在官方 XML 中搜索某个 ID、字段、token 或概念 |
| `resolve_localization` | 将游戏内本地化 token（如 `{=abc123}`）解析为实际文本 |
| `read_gauntlet_ui` | 查看 Gauntlet UI 界面文件的绑定关系和交互逻辑 |

### 官方/社区文档与 API

| 工具 | 功能说明 |
|------|----------|
| `search_bannerlord_knowledge` | 自然语言统一入口；用户说“我要做一个 Mod/功能/补丁”时优先用它同时查文档、API 和本地反编译源码 |
| `search_bannerlord_docs` | 搜索官方教程和 BannerlordModding.LT 社区文档，适合查流程、编辑器、资产、Gauntlet UI、模块结构等 |
| `search_bannerlord_api_docs` | 搜索官方 API Doxygen 符号；版本不匹配时只作历史参考，本地反编译源码仍是权威 |

### 结构化玩法查询

| 工具 | 功能说明 |
|------|----------|
| `get_entity` | 按 id 查一个玩法实体。`kind` 取值：`clan`、`culture`、`hero`、`item`、`kingdom`、`perk`、`policy`、`settlement`、`skill`、`troop` |

示例：`get_entity(kind="troop", id="vlandian_recruit")` 返回兵种升级树；`get_entity(kind="item", id="saddle_horse")` 返回物品属性。

### 本地 Mod 源码

> 这组工具操作的是你自己的本地 Mod 源码，不是官方导入源码。

| 工具 | 功能说明 |
|------|----------|
| `mod_source_status` | 检查本地 Mod 工作区是否可用、索引是否建立 |
| `index_mod_source` | 建立或刷新本地 Mod 源码的搜索索引 |
| `search_mod_source` | 在本地 Mod 源码中全文搜索 |
| `read_mod_file` | 读取本地 Mod 中的指定源码文件 |
| `list_mod_directory` | 浏览本地 Mod 的目录结构 |
| `read_mod_type` | 按类型名读取本地 Mod 中的 C# 类型定义 |

### Patch 与代码生成

| 工具 | 功能说明 |
|------|----------|
| `generate_harmony_patch` | 生成 Harmony Patch 代码骨架，含目标方法签名提示，参数类型需手动对照补全 |
| `create_mod_workspace` ⁺ | 生成基础 Mod 项目结构（SubModule.xml、.csproj、C# 入口），可直接 `dotnet build`；目标目录非空时拒绝覆盖 |
| `generate_xslt_patch` ⁺ | 生成 XSLT Patch 模板，辅助修改官方 XML；不校验 XPath 合法性，不验证 fragment 格式，仅作模板参考 |

> ⁺ 仅 `start:bannerlord:full` 提供。

## 常用工作流

**查官方源码：**
1. `search_source` 定位文件
2. `read_file` 读取片段
3. `read_csharp_type` 查类型定义

**查 XML 或本地化：**
1. `search_xml` 定位文件
2. `read_file` 读取内容
3. `resolve_localization` 解析 token

**已知游戏 ID，直接查：**
- 用 `get_entity` 并选对 `kind`：`get_item_stats` → `get_entity(kind="item")`，`trace_troop_tree` → `get_entity(kind="troop")`，`get_hero_profile` → `get_entity(kind="hero")`

**读本地 Mod 源码：**
1. `mod_source_status` 确认工作区
2. `search_mod_source` 搜索代码
3. `read_mod_file` / `read_mod_type` 读取详情

**带项目记忆地继续工作：**
1. `project_memory_read(action="wakeup")` 先加载关键上下文
2. `project_memory_read(action="search")` 确认以前是否已有类似决策、踩坑或偏好
3. `project_memory_write(action="capture_session")` 在任务结束前写入本轮值得保留的结论

## 日常怎么用这个 MCP

当 BannerlordSage 安装好并接到你的 AI 客户端后，日常工作流可以按这个顺序走：

1. 开始新任务或恢复旧任务时先调用 `project_memory_read(action="wakeup")`
2. 查官方行为时优先用 `search_source`、`read_file`、`read_csharp_type`
3. 查你自己的 Mod 源码时优先用 `mod_source_status`、`search_mod_source`、`read_mod_file`、`read_mod_type`
4. 已知游戏内 ID 时直接用 `get_entity`
5. 涉及“之前怎么定的”时先调用 `project_memory_read(action="search")`
6. 任务快结束时调用 `project_memory_write(action="capture_session")`

## 项目记忆工作流

项目记忆是一个本地回查层。它不会改变模型本身的上下文长度，只负责保存设计决策、踩坑、偏好和后续事项。

默认规则：

- 恢复任务时先 `project_memory_read(action="wakeup")`
- 涉及项目历史时先 `project_memory_read(action="search")`
- 只存以后还会有用的结论
- 任务接近结束时优先用 `project_memory_write(action="capture_session")`
- 旧结论失效时及时 `project_memory_write(action="invalidate")`

## 安装

### 1. 环境要求

- Windows
- 合法拥有的 Bannerlord 本地安装
- [Bun](https://bun.com/)
- [ripgrep](https://github.com/BurntSushi/ripgrep)
- [.NET SDK 8+](https://dotnet.microsoft.com/)
- [ILSpyCmd](https://github.com/icsharpcode/ILSpy)

一键安装依赖：

```powershell
powershell -c "irm bun.sh/install.ps1 | iex"
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.DotNet.SDK.8
dotnet tool install --global ilspycmd
```

### 2. 安装依赖

```bash
bun install
```

### 3. 运行 setup

```bash
bun run setup:bannerlord -- --game-dir "<BANNERLORD_GAME_DIR>"
```

`<BANNERLORD_GAME_DIR>` 替换为你本机的 Bannerlord 安装路径。首次运行较慢，后续增量执行。

setup 默认也会索引公开的官方教程、社区文档和官方 API 搜索数据。这些文档/API 数据会写入本地 SQLite，后续部署会复用；只有缺失或传入 `--reindex-docs` 时才会重新下载。离线或只想做本地索引时可使用 `--skip-docs`。

常用参数：

| 参数 | 说明 |
|------|------|
| `--dll-scope core` | 只反编译核心 TaleWorlds DLL（最快） |
| `--dll-scope modding` | 核心 + modding 支持库（Newtonsoft.Json 等） |
| `--dll-scope official` | 所有官方模块 DLL |
| `--dll-scope all` | 官方 + 第三方模块 DLL（最全，最慢） |
| `--xml-scope official` | 只导入官方模块的 XML |
| `--xml-scope all` | 官方 + 本地所有第三方模块 XML |
| `--accept-disclaimer` | 跳过交互式免责声明 |
| `--clean` | 清理本地资源并重建索引；除非同时传 `--skip-docs`，也会刷新文档/API |
| `--skip-docs` | setup 时不下载/索引官方文档和 API 文档 |
| `--reindex-docs` | 强制刷新官方/社区文档和所有官方 API 版本 |

### 4. 启动 MCP

```bash
# 默认（推荐）
bun run start:bannerlord

# 完整工具集
bun run start:bannerlord:full
```

## MCP 客户端配置

```toml
[mcp_servers.bannerlordsage]
command = "bun"
args = ["run", "src/entrypoints/bannerlord-stdio.ts"]
cwd = "<REPO_DIR>"
enabled = true
```

完整版：

```toml
[mcp_servers.bannerlordsage]
command = "bun"
args = ["run", "src/entrypoints/bannerlord-full-stdio.ts"]
cwd = "<REPO_DIR>"
enabled = true
```

`<REPO_DIR>` 替换为本仓库在你电脑上的绝对路径。

## 可选环境变量

| 变量 | 说明 |
|------|------|
| `BANNERSAGE_GAME` | 当前活动游戏 profile，目前固定为 `bannerlord` |
| `BANNERSAGE_BANNERLORD_GAME_DIR` | 默认 Bannerlord 安装路径 |
| `BANNERSAGE_GAME_DIR` | 通用默认游戏路径 |
| `BANNERSAGE_ILSPYCMD_EXE` | 覆盖 `ilspycmd` 可执行文件路径 |
| `BANNERSAGE_EULA_ACCEPTED=true` | 跳过交互式免责声明确认 |

## 可用脚本

```bash
bun run setup:bannerlord -- --game-dir "<BANNERLORD_GAME_DIR>"   # 初始化/更新本地和公开文档索引
bun run start:bannerlord                                         # 启动默认 MCP
bun run start:bannerlord:full                                    # 启动完整版 MCP
bun run verify:memory                                            # 验证原生项目记忆工具
bun run index:gameplay                                           # 单独重建玩法索引
bun run index:docs                                               # 手动刷新官方教程和社区文档
bun run index:api-docs                                           # 手动刷新官方 API 版本符号
bun run index:mod-source -- --source-dir "<MOD_SOURCE_DIR>"     # 索引本地 Mod 源码
bun run verify:bannerlord -- --game-dir "<BANNERLORD_GAME_DIR>" # 本机回归验证
bun run smoke:release                                            # 快速验证构建产物
bun run report:scopes -- --game-dir "<BANNERLORD_GAME_DIR>"     # 输出 scope 报告
```

## 项目结构

| 路径 | 说明 |
|------|------|
| `src/entrypoints/` | MCP 和 setup 入口 |
| `src/scripts/` | setup、索引、验证和发布脚本 |
| `src/tools/` | MCP 工具实现 |
| `src/utils/` | 共用运行时和索引逻辑 |
| `tools/BannerlordSage.CSharpIndexer/` | 基于 Roslyn 的 C# 索引器 |
| `dist/` | 本地生成的运行时数据（不提交） |
| `AGENTS.md` | AI coding agent 安装说明 |
| `AI_QUICKSTART.md` | 供用户复制给 AI 的安装提示模板 |

## 免责声明

本项目仅用于在合法拥有游戏副本前提下进行个人学习、研究和 Mod 开发。

1. 仓库本身不包含也不分发 Bannerlord 游戏资源。
2. 使用者需自行遵守游戏 EULA 和所在地法律。
3. 反编译和索引出的内容默认仅保留在本地。
