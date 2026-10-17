"""Reverse control for the $indexedAt regression test.

WHY: a test that passes proves nothing unless it would have FAILED on the buggy
code. This restores the exact defect (`$indexedAt: indexedAt` -> shorthand
`$indexedAt`) and asserts the check goes red.

It mutates a COPY of the source, runs the check against that copy, then restores.
The real file is never left modified: a reverse control that can corrupt the tree
it is testing is not worth running.

Usage:  python tools/reverse-controls/revctl-indexedat.py
"""
import io
import os
import shutil
import subprocess
import sys

# repo root, derived from this file's location (tools/reverse-controls/x.py -> ../..)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(REPO, 'src', 'scripts', 'index-csharp.ts')
CHECK = os.path.join(REPO, 'tests', 'checks', 'csharp-index.check.ts')
BUN = (r'C:\Users\LCGX\AppData\Local\Microsoft\WinGet\Packages'
       r'\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe'
       r'\bun-windows-x64\bun.exe')

GOOD = '        $indexedAt: indexedAt,\n'
BAD = '        $indexedAt,\n'


def run_check():
    p = subprocess.run([BUN, 'run', CHECK], capture_output=True, timeout=600, cwd=REPO)
    out = (p.stdout + p.stderr).decode('utf-8', 'replace')
    return p.returncode, out


def main():
    src = io.open(TARGET, encoding='utf-8').read()
    if GOOD not in src:
        print('anchor not found — the file has changed shape; fix this control first')
        return 1

    print('=== baseline (fixed code) ===')
    code, out = run_check()
    tail = [l for l in out.splitlines() if l.startswith(('PASS', 'FAIL', 'all assertions', 'csharp-index'))]
    print('\n'.join(tail[-4:]))
    print('exit=%d' % code)
    if code != 0:
        print('baseline is red — fix that before testing the control')
        return 1

    backup = TARGET + '.revctl.bak'
    shutil.copyfile(TARGET, backup)
    try:
        print('\n=== mutated (the original bug restored) ===')
        io.open(TARGET, 'w', encoding='utf-8').write(src.replace(GOOD, BAD, 1))
        code, out = run_check()
        tail = [l for l in out.splitlines() if l.startswith(('PASS', 'FAIL', 'all assertions', 'csharp-index', 'ReferenceError'))]
        print('\n'.join(tail[-6:]))
        print('exit=%d' % code)
        if code == 0:
            print('\nFAIL: the check still passes on the buggy code — it does not test what it claims')
            return 1
        if 'indexedAt' not in out:
            print('\nFAIL: the check went red, but not for the $indexedAt reason')
            return 1
        print('\nOK: restoring the bug turns the check red, with the $indexedAt error')
    finally:
        shutil.copyfile(backup, TARGET)
        os.remove(backup)
        print('restored %s' % TARGET)
    return 0


if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.exit(main())
