"""Reverse control for csharpIndexIsStale.

Restores the exact defect — a staleness check that only asks "do the tables exist" —
and asserts the test goes red. Then restores.

A fix without this control is a claim that the test would have caught the bug. This
checks that claim instead of believing it.

Usage:  python tools/reverse-controls/revctl-csharp-stale.py
"""
import io
import os
import shutil
import subprocess
import sys

# repo root, derived from this file's location (tools/reverse-controls/x.py -> ../..)
REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TARGET = os.path.join(REPO, 'src', 'scripts', 'setup.ts')
CHECK = os.path.join(REPO, 'tests', 'checks', 'setup-csharp-stale.check.ts')
BUN = (r'C:\Users\LCGX\AppData\Local\Microsoft\WinGet\Packages'
       r'\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe'
       r'\bun-windows-x64\bun.exe')

# The line that makes the comparison real. Replacing the FUNCTION BODY's verdict
# with an unconditional 'fresh' is exactly the old behaviour: tables exist => not
# stale.
#
# ★ The first version of this mutant inserted `...({stale:false,...})` at the TOP of
# the object literal, and the explicit fields below it overwrote the spread — so the
# mutant was a no-op and the check passed. That is the same trap as an unobservable
# mutation: a change that cannot be seen proves nothing. The mutant now replaces the
# verdict line itself, after the fields are computed.
ANCHOR = "  result.stale = result.reason !== 'fresh'\n"
MUTANT = "  result.stale = false; result.reason = 'fresh'  // MUTANT: old behaviour\n"


def run_check():
    p = subprocess.run([BUN, 'run', CHECK], capture_output=True, timeout=600, cwd=REPO)
    out = (p.stdout + p.stderr).decode('utf-8', 'replace')
    return p.returncode, out


def main():
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    src = io.open(TARGET, encoding='utf-8').read()
    if ANCHOR not in src:
        print('anchor not found; fix this control')
        return 1

    print('=== baseline ===')
    code, out = run_check()
    print('\n'.join([l for l in out.splitlines() if l.startswith(('PASS', 'FAIL', 'all assert'))][-4:]))
    if code != 0:
        print('baseline red — fix that first')
        return 1

    backup = TARGET + '.revctl.bak'
    shutil.copyfile(TARGET, backup)
    try:
        print('\n=== mutant: staleness always "fresh" (the old behaviour) ===')
        io.open(TARGET, 'w', encoding='utf-8').write(src.replace(ANCHOR, MUTANT, 1))
        code, out = run_check()
        fails = [l for l in out.splitlines() if l.startswith('FAIL')]
        print('\n'.join(fails) or '(no FAIL lines)')
        print('exit=%d' % code)
        if code == 0:
            print('\nFAIL: the check still passes on the old behaviour — it does not test what it claims')
            return 1
        print('\nOK: the old "tables exist so it is fresh" behaviour turns the check red')
    finally:
        shutil.copyfile(backup, TARGET)
        os.remove(backup)
        print('restored')
    return 0


if __name__ == '__main__':
    sys.exit(main())
