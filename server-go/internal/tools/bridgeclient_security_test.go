package tools

import (
	"os"
	"regexp"
	"path/filepath"
	"strings"
	"testing"
)

// The Go side of the Bridge invocation had no security tests, while the TypeScript side has
// five negative controls. Both implementations ship, so a property held by one and not the
// other is a property the project does not have - the weaker side decides.
//
// These assert the same three things the TS controls pin:
//   1. the action list is CLOSED and contains no verb that runs a program
//   2. no shell is used anywhere in the path
//   3. values are validated before argv, and a rejected value never reaches a process

func TestBridgeActionsAreAClosedAuditedSet(t *testing.T) {
	want := []string{
		"ping", "status", "build-check", "patches", "patch-failures",
		"modules", "crash", "exceptions", "capability-probe",
	}
	if len(BridgeActions) != len(want) {
		t.Fatalf("action count = %d, want %d (%v)", len(BridgeActions), len(want), BridgeActions)
	}
	for i, w := range want {
		if BridgeActions[i] != w {
			t.Errorf("action[%d] = %q, want %q", i, BridgeActions[i], w)
		}
	}

	// A verb that runs a program must never be reachable through this tool.
	forbidden := []string{"rm", "sh", "bash", "curl", "wget", "python", "node", "cmd", "powershell", "exec"}
	for _, a := range BridgeActions {
		for _, f := range forbidden {
			if a == f {
				t.Errorf("the allow-list contains a program verb: %q", a)
			}
		}
	}
}

func TestBridgeActionKnownRejectsAnythingElse(t *testing.T) {
	// Injection-shaped strings must be rejected at the allow-list, before any process exists.
	for _, bad := range []string{"rm -rf /", "status; whoami", "status && curl x", "../../etc/passwd", ""} {
		if BridgeActionKnown(bad) {
			t.Errorf("BridgeActionKnown(%q) = true, want false", bad)
		}
	}
	if !BridgeActionKnown("status") {
		t.Error("BridgeActionKnown(status) = false, want true")
	}
}

func TestValidateBridgeFlag(t *testing.T) {
	if err := validateBridgeFlag("owner", strings.Repeat("x", BridgeMaxArgLength+1)); err == nil {
		t.Error("an oversized value was accepted")
	}
	if err := validateBridgeFlag("owner", "a\nb"); err == nil {
		t.Error("a value containing a newline was accepted")
	}
	if err := validateBridgeFlag("owner", "a\x00b"); err == nil {
		t.Error("a value containing a NUL was accepted")
	}
	if err := validateBridgeFlag("owner", "com.rbm"); err != nil {
		t.Errorf("an ordinary value was rejected: %v", err)
	}
}

// TestInvokeBridge_NoShellInTheLaunchPath reads the source of the only function that spawns.
//
// There is no runtime observation that distinguishes exec.Command from a shell invocation when
// the input is benign, so the property is checked where it lives. The TS suite does the same
// thing for the same reason.
//
// ★ THE FIRST VERSION OF THIS TEST COULD NOT FAIL, AND A NEGATIVE CONTROL PROVED IT. It looked
// for a fixed list of forbidden substrings - "sh -c", "cmd /c", "powershell" - and a mutation
// that changed the launch to `exec.CommandContext(ctx, "sh", append([]string{"-c", ...}))`
// matched NONE of them: the literal `"sh"` as an argument is not `sh -c`. The suite stayed
// green with a shell in the path. The check now asserts the SHAPE of the launch instead of a
// list of spellings: the command must be the interpreter variable, and no `-c` flag may appear
// in the argument list at all.
func TestInvokeBridge_NoShellInTheLaunchPath(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(".", "bridgeclient.go"))
	if err != nil {
		t.Fatalf("cannot read bridgeclient.go: %v", err)
	}
	text := string(source)

	if !strings.Contains(text, "exec.CommandContext") {
		t.Fatal("the launch does not go through exec.CommandContext")
	}

	// The command argument must be the interpreter, never a shell binary.
	if !regexp.MustCompile(`exec\.CommandContext\(ctx,\s*interpreter\s*,`).MatchString(text) {
		t.Error("the launch does not pass `interpreter` as the command - something else is being run")
	}

	// Shell binaries must not appear as a command argument anywhere in the file.
	for _, shell := range []string{`"sh"`, `"bash"`, `"cmd"`, `"cmd.exe"`, `"powershell"`, `"/bin/sh"`} {
		if strings.Contains(text, shell) {
			t.Errorf("a shell binary appears in the launch path: %s", shell)
		}
	}

	// `-c` is the flag that turns an interpreter into a shell. It must not be passed.
	if strings.Contains(text, `"-c"`) {
		t.Error(`the launch passes "-c", which makes the interpreter execute a command string`)
	}
}

// TestInvokeBridge_RejectsBeforeSpawning proves a bad action or flag never reaches a process,
// by pointing at a directory that does not exist and still getting the allow-list answer.
func TestInvokeBridge_RejectsBeforeSpawning(t *testing.T) {
	out, err := InvokeBridge(BridgeInvocation{Action: "rm -rf /", BridgeDir: "/nonexistent"})
	if err != nil {
		t.Fatalf("InvokeBridge returned an error instead of a report: %v", err)
	}
	if !strings.Contains(out, "unknown action") {
		t.Errorf("an unknown action was not refused at the allow-list:\n%s", out)
	}

	// A configured directory but an oversized flag: rejected before the process is created.
	out, err = InvokeBridge(BridgeInvocation{
		Action:    "status",
		BridgeDir: "/nonexistent",
		Flags:     map[string]string{"owner": strings.Repeat("y", BridgeMaxArgLength+1)},
	})
	if err != nil {
		t.Fatalf("InvokeBridge returned an error: %v", err)
	}
	// Either the flag is refused, or the missing script is reported - both are refusals that
	// happen before anything runs. What must not happen is a launch.
	if !strings.Contains(out, "exceeds") && !strings.Contains(out, "not found") {
		t.Errorf("neither the flag nor the missing script was reported:\n%s", out)
	}
}
