#!/usr/bin/env python3
"""Make ADDITIVE-ONLY edits to tools/rewrite-verify/README.md.

★ WHY THIS IS A SCRIPT AND NOT A `write` CALL.
  README.md is shared: the Lead maintains a long version of it for the whole harness while this
  task adds sections for the src/tools runners. A whole-file `write` silently REPLACED the
  Lead's content TWICE, losing sections that took them real work to write. Every edit here is an
  `assert old in text; text = text.replace(old, new)` against the CURRENT file, and an anchor
  that is not found is a LOUD failure rather than a silent overwrite. Additive only: nothing is
  ever removed.

Usage:
    python tools/rewrite-verify/patch_readme.py            # apply (idempotent)
    python tools/rewrite-verify/patch_readme.py --check    # report what is missing, change nothing
"""
import io
import sys

README = 'tools/rewrite-verify/README.md'
CHECK_ONLY = '--check' in sys.argv

# ── the additions: (anchor, insertion appended AFTER the anchor line) ────────
# Each anchor is a single existing line; the addition goes right after it.
ADDITIONS = [
    # 1. the usage block gains the four runners this task added
    (
        '"$BUN" tools/rewrite-verify/diff_utils_units.mjs   # utils 纯函数类',
        [
            '"$BUN" tools/rewrite-verify/diff_pure.mjs          # harmony / xslt 补丁生成器',
            '"$BUN" tools/rewrite-verify/diff_memory.mjs        # 6 个 project-memory + read-csharp-type',
            '"$BUN" tools/rewrite-verify/diff_doctor.mjs        # bannerlord-doctor',
            '"$BUN" tools/rewrite-verify/diff_gauntlet.mjs      # read-gauntlet-ui',
        ],
    ),
    # 2. the coverage-gap table gains the five indirect-coverage mod-source rows
    (
        '| `project-memory-*.ts`（5 个） | ❌ 无 | 需要 memory DB |',
        [
            '| `list-mod-directory.ts` | ⚠️ 仅间接 | `gen_modsourceindex_fixtures.mjs` 只驱动 **facade**（`utils/local-mod-csharp-index.ts`），从不经过本入口 |',
            '| `read-mod-file.ts` | ⚠️ 仅间接 | 同上 |',
            '| `index-mod-source.ts` | ⚠️ 仅间接 | 该生成器 mock 的是 **script**（`src/scripts/index-mod-source.ts`），不是这个包装 |',
            '| `mod-source-status.ts` | ⚠️ 仅间接 | 同上 |',
            '| `read-mod-type.ts` | ⚠️ 仅间接 | 同上 |',
        ],
    ),
    # 3. the runner table gains the four new runners
    (
        '| `diff_tools.mjs` | `list-directory`、`read-file`、6 个 mod-source 包装 | 40 |',
        [
            '| `diff_pure.mjs` | `generate-harmony-patch`、`generate-xslt-patch` | 75 |',
            '| `diff_memory.mjs` | 6 个 `project-memory-*`、`read-csharp-type` | 24 |',
            '| `diff_doctor.mjs` | `bannerlord-doctor`（语料覆盖 11 种 issue type 中的 10 种） | 21 |',
            '| `diff_gauntlet.mjs` | `read-gauntlet-ui`（含打分排名与缓存隔离） | 24 |',
        ],
    ),
    # 4. the negative-control record gains the new measurements
    (
        '| `mod-source-sandbox.ts` 把 sandbox 根改成 `sourceDir + \'/src\'` | 3 个文件分歧（`list-mod-directory`、`read-mod-file`、`search-mod-source`） |',
        [
            '| `splitTopLevel` 忽略方括号深度 | 1 case（`Solo/Ranks`，`int[,]`） |',
            '| `indentFragment` 用 tab | 44/55 xslt cases |',
            '| `project-memory-recent` 的 `\'all\'` → `\'ALL\'` | 8/10 |',
            '| `read-csharp-type` 的 `sourcePath` 拼错 | 4/7 |',
            '| doctor：改 shared-DLL 集合 + 关 official-skip | 5/21 |',
            '| memory runner 查错模块 key | 10/10 全部标 UNEXPECTED（**不是**假绿） |',
            '| gauntlet：`score15` / `score20` / `drop30` / `exact` / `dedupe` | 1/24、1/24、1/24、5/24、17/24 |',
            '| gauntlet：`score25`（**对照**，未跨越 20 档） | 绿 —— 本就不该被抓 |',
        ],
    ),
]

# ── appended sections, appended at end of file (each guarded by a marker) ────
SECTIONS = [
    (
        '<!-- TRAP-RESTORE-MARKER -->',
        """
---

## ★★ 陷阱 5：`restore` 绝不能用 `git checkout` —— 它会抹掉未提交的改写

**这是最贵的一条，它由测试工具本身造出过一次假绿。**

第一版 `mutate_gauntlet_ui.py` 用 `git checkout -- <file>` 做 `restore`。**那会丢弃未提交的改动。**
当时 `read-gauntlet-ui.ts` 的改写尚未提交，"restore" 把它还原到改写前的 HEAD 版本 →
**改写整个消失** → 下一次 harness 跑，两侧都是同一个原始文件 → **`ALL EQUAL`**。
连续两次如此，且症状隐蔽（"确认恢复"时看到绿，以为正常）。

**修法**：`restore` 从快照 `<file>.mutbak` 恢复，永不 `git checkout`；
快照在首次使用时**自动**建立，忘了 `backup` 也不会丢文件。
另外：关键 `write` 之后**每次都核对行数与标记数** —— 期间还遇到过一次
`write` 报成功但内容未落盘（原因未明）。

**任何写变异注入脚本的人都要遵守这条。**
""",
    ),
    (
        '<!-- TRAP-SCORE-MARKER -->',
        """
---

## ★★ 陷阱 6：路径标记的前导斜杠 + 打分重叠（**两层**遮蔽）

`getUiMatchScore` 判的是 `'/gui/prefabs/'` —— **带前导斜杠**。glob 以 sandbox 根为
`cwd`，返回**相对**路径，没有前导分隔符。实测：

```
"gui/prefabs/PanelPrefab.xml"   /gui/prefabs/ = false   /gui/ = false   /prefabs/ = true
"gui/PanelGui.xml"              /gui/prefabs/ = false   /gui/ = false   /prefabs/ = false
```

**不是 30 档降级到 10 档，是 30 和 20 两档全不可达。** 语料必须给候选加一层前导段
（`z/gui/prefabs/…`、`a/gui/…`），同时保留相对形状（`gui/PanelRel.xml`）去钉"无标记命中"分支。

**而且还有第二层遮蔽**：`'/gui/prefabs/'` **包含** `'/gui/'`，所以 30 分那文件同时是 20 分候选。
丢掉 30 后它与 20 文件**打平**，再由 `localeCompare` 决定 —— 于是**还是同一个文件赢**
（ICU 把 `prefabs` 排在 `RankShared` 前）。所以要**让 30 文件在平局时排最后**：
30 文件放 `z/gui/prefabs/`，20 文件放 `a/gui/`，10 文件放 `c/prefabs/`，0 文件放 `d/`。

这一个遮蔽实测撞了**三次**才定位。

> **推论**：「跨越阈值」不是充分判据 —— **还要考虑平局之后的排序**。
> 一个只跨越阈值的变异仍可能被平局排序掩盖成绿。

**另外**：`exact` 分支我原来也测不到。为此加了 `a/gui/WidgetExtra.xml`，让 `Widget`
**同时**有 exact 命中（顶部 `Widget.xml`，0 分）和 prefix 命中（`WidgetExtra`，20 分）——
只有 exact 优先才会选 0 分那个。**一条分支要可观测，必须有另一个候选能"顶替"它。**
""",
    ),
]


def read():
    with io.open(README, encoding='utf-8', newline='') as fh:
        return fh.read()


def write(text):
    with io.open(README, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)


def main():
    text = read()
    original = text
    problems = []

    # additions: anchor a single line, insert after it
    for anchor, lines in ADDITIONS:
        if anchor not in text:
            problems.append(f'anchor NOT FOUND: {anchor[:70]}')
            continue
        # skip if the first addition line is already present next to the anchor
        if lines[0] in text and lines[-1] in text:
            continue
        text = text.replace(anchor, anchor + '\n' + '\n'.join(lines), 1)

    # sections: append unless the marker is already present
    for marker, body in SECTIONS:
        if marker in text:
            continue
        text = text.rstrip('\n') + '\n' + body.rstrip('\n') + '\n\n' + marker + '\n'

    if problems:
        print('REFUSING — the file has drifted from the anchors this script knows:', file=sys.stderr)
        for p in problems:
            print('  ' + p, file=sys.stderr)
        print('\nNo change was written. Update the anchors in this script to match the file.', file=sys.stderr)
        return 3

    if CHECK_ONLY:
        changed = text != original
        print('would change' if changed else 'already up to date')
        return 0

    if text == original:
        print('no change needed (already patched)')
        return 0

    write(text)
    added = len(text.splitlines()) - len(original.splitlines())
    print(f'patched {README}: +{added} lines, nothing removed')
    return 0


if __name__ == '__main__':
    sys.exit(main())
