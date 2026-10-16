#!/usr/bin/env python3
"""Report whether the current rewrite-verify README still contains every line of each
historical revision, and whether it ever lost one along the way.

Line-presence is the right test here: this file has been edited by more than one person, and
the risk being checked is CONTENT LOSS (whole sections disappearing), not rewrapping.

Usage: python tools/rewrite-verify/check_readme_history.py
"""
import io
import subprocess
import sys

README = 'tools/rewrite-verify/README.md'
REVS = ['faa60e4', '59aa56a', 'c9dd960', 'HEAD']


def norm(text):
    return [l.strip() for l in text.replace('\r\n', '\n').split('\n') if l.strip()]


def show(rev):
    out = subprocess.run(
        ['git', 'show', f'{rev}:{README}'], capture_output=True, check=False
    )
    if out.returncode != 0:
        return None
    return out.stdout.decode('utf-8', 'replace')


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')

    current = io.open(README, encoding='utf-8', errors='replace').read()
    current_lines = set(norm(current))
    current_bytes = len(current.encode('utf-8'))
    print(f'current {README}: {len(norm(current))} non-blank lines, {current_bytes} bytes\n')

    print(f'{"rev":10} {"bytes":>8} {"lines":>6} {"missing from current":>22}')
    for rev in REVS:
        text = show(rev)
        if text is None:
            print(f'{rev:10} {"(absent)":>8}')
            continue
        lines = norm(text)
        missing = [l for l in lines if l not in current_lines]
        print(f'{rev:10} {len(text.encode("utf-8")):>8} {len(lines):>6} {len(missing):>22}')
        for m in missing[:8]:
            print(f'{"":10}   MISSING: {m[:100]}')

    print('\n-- pairwise: did any revision lose lines relative to an earlier one? --')
    prev = None
    for rev in REVS:
        text = show(rev)
        if text is None:
            continue
        lines = set(norm(text))
        if prev is not None:
            lost = [l for l in prev[1] if l not in lines]
            verdict = 'no loss' if not lost else f'LOST {len(lost)}'
            print(f'  {prev[0]} -> {rev}: {verdict}')
            for l in lost[:8]:
                print(f'      {l[:100]}')
        prev = (rev, lines)


if __name__ == '__main__':
    main()
