//go:build windows

package parity_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// createJunction makes a DIRECTORY JUNCTION at link pointing at target.
//
// ★ A JUNCTION, NOT A SYMLINK, BECAUSE A JUNCTION NEEDS NO PRIVILEGES. Windows requires elevation (or
// Developer Mode) for `New-Item -ItemType SymbolicLink`, and those are usually unavailable — which is
// why an earlier note in this suite wrongly recorded the whole class as untestable. A junction is a
// reparse point of the MOUNT-POINT kind and needs no elevation, and it is exactly the kind whose
// dirent the two runtimes report differently (Go: ModeIrregular 0x80000, Node: isSymbolicLink true).
//
// ★ THE PATHS ARE MADE ABSOLUTE FIRST, AND THAT IS NOT COSMETIC. The first version passed the
// caller's paths through unchanged, which works for `t.TempDir()` (absolute) but breaks the moment a
// caller hands in a relative path: the helper spawns a CHILD PROCESS whose working directory is not
// the caller's, so a relative target resolves somewhere else and the command fails. That is what made
// the runtime-check junction test SKIP while the same helper worked in a hand-written probe.
//
// ★ THE CALLERS ARE OPT-IN, AND THE HELPER IS THE REASON. Creating a link is exactly what real-time
// security software watches for, and because `go test` builds into a fresh temp path each run, a
// prompt reappears every time — a sweep multiplies that by its injection count. The gate lives in
// the TESTS (BLORE_TEST_JUNCTION_TESTS=1); when they do run and creation is blocked, they SKIP
// instead of failing, so either answer to the prompt leaves the suite honest.
func createJunction(link, target string) error {
	link, err := filepath.Abs(link)
	if err != nil {
		return err
	}
	target, err = filepath.Abs(target)
	if err != nil {
		return err
	}

	attempts := []struct {
		name string
		run  func() ([]byte, error)
	}{
		{"mklink /J", func() ([]byte, error) {
			// cmd's builtin; /J needs no privileges. Tried FIRST because spawning cmd is an order of
			// magnitude cheaper than starting PowerShell, and a test that spends a minute creating one
			// junction is a test people start skipping.
			return exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
		}},
		{"powershell New-Item Junction", func() ([]byte, error) {
			script := fmt.Sprintf(
				"New-Item -ItemType Junction -Path '%s' -Target '%s' | Out-Null",
				strings.ReplaceAll(link, "'", "''"),
				strings.ReplaceAll(target, "'", "''"))
			return exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", script).CombinedOutput()
		}},
	}

	var lastErr error
	for _, a := range attempts {
		if out, err := a.run(); err == nil {
			if _, statErr := os.Stat(link); statErr == nil {
				return nil
			}
			// The command reported success but the link is not there — fall through to the next helper
			// rather than returning a false positive.
			lastErr = fmt.Errorf("%s reported success but %s does not exist", a.name, link)
			continue
		} else {
			lastErr = fmt.Errorf("%s: %v (%s)", a.name, err, strings.TrimSpace(string(out)))
		}
	}
	return lastErr
}
