"""Reverse control for the F19 mod-source workspace guard.

Restores the hazard the guard exists to prevent, and asserts the check goes red.

THE HAZARD, in one line: a cache directory that cannot be shown to be ours must not
be deletable. The naive implementation of `classifyModSourceWorkspace` is "the
directory exists, so it is a cache we can rebuild" — which is exactly what deletes
somebody's data. This control makes `unknown` deletable and requires the test to
notice.
"""
import io
import os
import shutil
import subprocess
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(REPO, 'src', 'utils', 'mod-source.ts')
CHECK = os.path.join(REPO, 'tests', 'checks', 'mod-source-f19.check.ts')
BUN = (r'C:\Users\LCGX\AppData\Local\Microsoft\WinGet\Packages'
       r'\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe'
       r'\bun-windows-x64\bun.exe')

# The three 'unknown' return sites all set deletable: false. Mutating the FIRST one
# (the no-marker case) is the sharpest test: that is precisely the 18 real 3-column
# caches on this machine, and precisely what a "clean cache" would hit.
ANCHOR = """    return {
      kind: 'unknown',
      deletable: false,
      reason: 'no workspace.json marker — this cache cannot be shown to be ours',
    }"""
MUTANT = """    return {
      kind: 'unknown',
      deletable: true, // MUTANT: "the directory exists, so it must be ours"
      reason: 'no workspace.json marker — this cache cannot be shown to be ours',
    }"""


def run():
    p = subprocess.run([BUN, 'run', CHECK], capture_output=True, timeout=600, cwd=REPO)
    return p.returncode, (p.stdout + p.stderr).decode('utf-8', 'replace')


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    src = io.open(TARGET, encoding='utf-8').read()
    if ANCHOR not in src:
        print('anchor not found; the guard has changed shape, fix this control')
        return 1

    print('=== baseline ===')
    code, out = run()
    print('\n'.join([l for l in out.splitlines() if l.startswith(('PASS', 'FAIL', 'all assert', '  (real'))][-4:]))
    if code != 0:
        print('baseline is red — fix that first')
        return 1

    backup = TARGET + '.revctl.bak'
    shutil.copyfile(TARGET, backup)
    try:
        print('\n=== mutant: unmarked workspace becomes deletable ===')
        io.open(TARGET, 'w', encoding='utf-8').write(src.replace(ANCHOR, MUTANT, 1))
        code, out = run()
        fails = [l for l in out.splitlines() if l.startswith('FAIL')]
        print('\n'.join(fails[:5]) or '(no FAIL lines)')
        tail = [l for l in out.splitlines() if 'real:' in l]
        if tail:
            print(tail[0])
        print('exit=%d' % code)
        if code == 0:
            print('\nFAIL: the guard still passes when it declares unknown caches deletable.')
            print('      That means the test does not actually protect the 18 old caches.')
            return 1
        print('\nOK: making an unmarked cache deletable turns the check red')
    finally:
        shutil.copyfile(backup, TARGET)
        os.remove(backup)
        print('restored')
    return 0


if __name__ == '__main__':
    sys.exit(main())
