#!/usr/bin/env python3
"""Inject a mutation into read-gauntlet-ui.ts, and restore it from a BACKUP.

★ WHY RESTORE USES A BACKUP AND NOT `git checkout`.
  The first version of this script restored with `git checkout -- <file>`, which silently
  DISCARDS UNCOMMITTED WORK. A whole re-implementation of read-gauntlet-ui.ts was lost that way:
  the file was not yet committed, so "restore" restored it to the pre-rewrite HEAD revision and
  the rewrite vanished — and the very next harness run passed, because both sides were now the
  same original file. A false green produced by the test tooling itself.
  This version snapshots the file to <file>.mutbak before the first mutation and restores from
  that snapshot, so it can never reach past uncommitted state.

★ WHY THIS IS A FILE AND NOT AN INLINE COMMAND.
  The score marker contains a forward slash and the replacements contain single quotes. Inline
  heredocs had their quoting eaten, and the failure looked like "constant not found" — a WRONG
  error message costs more than no error at all. This script instead REFUSES loudly, naming the
  exact text it looked for.

Usage:
    python tools/rewrite-verify/mutate_gauntlet_ui.py backup    # snapshot the current file
    python tools/rewrite-verify/mutate_gauntlet_ui.py score15   # 30 -> 15, crosses the 20 rank
    python tools/rewrite-verify/mutate_gauntlet_ui.py score25   # 30 -> 25, stays above 20
    python tools/rewrite-verify/mutate_gauntlet_ui.py drop30    # drop the 30 entry
    python tools/rewrite-verify/mutate_gauntlet_ui.py score20   # 30 -> 20, ties with /gui/
    python tools/rewrite-verify/mutate_gauntlet_ui.py exact     # disable the exact-stem branch
    python tools/rewrite-verify/mutate_gauntlet_ui.py dedupe    # stop deduping captures
    python tools/rewrite-verify/mutate_gauntlet_ui.py restore   # restore from the snapshot
"""
import io
import os
import shutil
import sys

TARGET = 'src/tools/read-gauntlet-ui.ts'
BACKUP = TARGET + '.mutbak'

# The constants as they appear in the REWRITE (UI_MATCH_SCORES table, not the original if-chain).
ORIG_30 = "  ['/gui/prefabs/', 30],"
ORIG_EXACT = "const exactMatches = filterByStem(candidates, stem => stem === normalizedQuery)"
ORIG_DEDUPE = "      values.add(value)"

MUTATIONS = {
    # 30 -> 15 crosses below the 20 rank, so the 20-point file must win instead. This is the
    # discriminating case the Lead's report asked for.
    'score15': (ORIG_30, "  ['/gui/prefabs/', 15],"),
    # 30 -> 25 stays above 20, so the ORDER is unchanged. The CONTROL: it proves the harness
    # reacts to a rank CROSSING, not to the constant merely changing.
    'score25': (ORIG_30, "  ['/gui/prefabs/', 25],"),
    # 30 -> 20 creates a TIE with the /gui/ entry, which localeCompare must then break.
    'score20': (ORIG_30, "  ['/gui/prefabs/', 20],"),
    # Remove the 30 entry, so the next-highest (20) must win.
    'drop30': (ORIG_30, "  // removed for mutation testing"),
    # Empty exact-stem set, forcing every lookup down the prefix path.
    'exact': (ORIG_EXACT, "const exactMatches = [] as string[]"),
    # Stop deduping, so the reported counts double for repeated captures.
    'dedupe': (ORIG_DEDUPE, "      values.add(value)\n      values.add(value + value)"),
}


def read_text(path):
    with io.open(path, encoding='utf-8', newline='') as fh:
        return fh.read()


def write_text(path, text):
    with io.open(path, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)


def main():
    valid = list(MUTATIONS) + ['restore', 'backup']
    if len(sys.argv) != 2 or sys.argv[1] not in valid:
        print(__doc__)
        return 2

    mode = sys.argv[1]

    if mode == 'backup':
        shutil.copyfile(TARGET, BACKUP)
        print(f'snapshotted {TARGET} -> {BACKUP}')
        return 0

    if mode == 'restore':
        if not os.path.exists(BACKUP):
            print(f'REFUSING: no snapshot at {BACKUP}; run `backup` first.', file=sys.stderr)
            return 3
        shutil.copyfile(BACKUP, TARGET)
        print(f'restored {TARGET} from {BACKUP} (NOT from git — never touches uncommitted work)')
        return 0

    if not os.path.exists(BACKUP):
        # Take the snapshot on first use, so a forgotten `backup` step cannot cost the file.
        shutil.copyfile(TARGET, BACKUP)
        print(f'(auto-snapshot) {TARGET} -> {BACKUP}')

    old, new = MUTATIONS[mode]
    text = read_text(TARGET)

    if old not in text:
        print(f'REFUSING: the text to mutate was not found in {TARGET}.', file=sys.stderr)
        print(f'  looked for: {old!r}', file=sys.stderr)
        print(f'  restore the clean file with: python {sys.argv[0]} restore', file=sys.stderr)
        return 3

    write_text(TARGET, text.replace(old, new, 1))
    print(f'INJECTED {mode}: {old.strip()}  ->  {new.strip()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
