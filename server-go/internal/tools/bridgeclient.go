package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// BridgeActions is the CLOSED set of Bridge CLI actions this server will forward.
//
// A general "run this command" tool would be a remote code execution surface wearing a
// helpful description. This one exists to answer a specific question - what did the running
// game actually do - so the list is enumerated and anything outside it is refused before a
// process is created.
var BridgeActions = []string{
	"ping",
	"status",
	"build-check",
	"patches",
	"patch-failures",
	"modules",
	"crash",
	"exceptions",
	"capability-probe",
}

// bridgeNeedsGame marks the actions that require a running game. Kept so a timeout can be
// reported with the likely reason rather than as a bare failure.
var bridgeNeedsGame = map[string]bool{
	"ping": true, "status": true, "patches": true, "patch-failures": true,
	"modules": true, "crash": true, "exceptions": true, "capability-probe": true,
}

const (
	BridgeMaxArgLength = 200
	BridgeTimeout      = 60 * time.Second
)

// BridgeInvocation is one request to the Bridge CLI.
type BridgeInvocation struct {
	Action    string
	BridgeDir string
	Flags     map[string]string
}

// BridgeActionKnown reports whether an action is in the closed set.
func BridgeActionKnown(action string) bool {
	for _, a := range BridgeActions {
		if a == action {
			return true
		}
	}
	return false
}

// validateBridgeFlag rejects values that cannot safely reach argv.
//
// The cap matters because these come from a model: an unbounded string is an unbounded argv
// entry. The control-character check matters because a newline or NUL will not survive the OS
// boundary intact, and a value that arrives truncated is worse than one that is refused.
func validateBridgeFlag(name, value string) error {
	if len(value) > BridgeMaxArgLength {
		return fmt.Errorf("%s exceeds %d characters", name, BridgeMaxArgLength)
	}
	if strings.ContainsAny(value, "\x00\r\n") {
		return fmt.Errorf("%s contains a control character", name)
	}
	return nil
}

// InvokeBridge runs one Bridge action through the project's own CLI and renders the result.
//
// WHY A SUBPROCESS AND NOT A NATIVE CLIENT: the Bridge's control channel is a file IPC with a
// request-expiry gate built so that a request left behind by a timed-out caller cannot be
// executed later as a "ghost battle". Re-implementing that handshake here would create a
// second place for it to be wrong, and would bypass the checks the CLI already performs.
//
// WHAT IT COSTS, STATED: errors arrive as text and an exit code rather than as typed
// exceptions, so the detail is coarser than an in-process call. That is the price of not
// sharing code across a module boundary, paid deliberately.
func InvokeBridge(inv BridgeInvocation) (string, error) {
	action := strings.TrimSpace(inv.Action)
	if action == "" {
		return "report_type: bridge_query\nerror: action is required\nknown_actions: " +
			strings.Join(BridgeActions, ", ") + "\n", nil
	}
	if !BridgeActionKnown(action) {
		return fmt.Sprintf("report_type: bridge_query\nerror: unknown action %s\nknown_actions: %s\n",
			action, strings.Join(BridgeActions, ", ")), nil
	}

	bridgeDir := strings.TrimSpace(inv.BridgeDir)
	if bridgeDir == "" {
		bridgeDir = strings.TrimSpace(os.Getenv("BANNERSAGE_BRIDGE_DIR"))
	}
	if bridgeDir == "" {
		return "report_type: bridge_query\nerror: bridge directory not configured: set BANNERSAGE_BRIDGE_DIR " +
			"or pass bridgeDir (the folder containing bl_cmd.py)\n", nil
	}

	script := filepath.Join(bridgeDir, "bl_cmd.py")
	if _, err := os.Stat(script); err != nil {
		return fmt.Sprintf("report_type: bridge_query\nerror: bl_cmd.py not found in %s\n", bridgeDir), nil
	}

	// Validate every flag BEFORE building argv, so a rejected value never reaches a process.
	args := []string{script, action}
	for name, value := range inv.Flags {
		if err := validateBridgeFlag(name, value); err != nil {
			return fmt.Sprintf("report_type: bridge_query\nerror: %s\n", err.Error()), nil
		}
		args = append(args, "--"+name, value)
	}

	ctx, cancel := context.WithTimeout(context.Background(), BridgeTimeout)
	defer cancel()

	interpreters := []string{"python", "python3"}
	var lastErr string
	for _, interpreter := range interpreters {
		cmd := exec.CommandContext(ctx, interpreter, args...)
		cmd.Dir = bridgeDir
		// No shell: values are values, not syntax. exec.Command does not invoke one, and
		// there is no string concatenation of the command line anywhere above.
		out, err := cmd.CombinedOutput()

		if err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				reason := "the CLI did not finish in time"
				if bridgeNeedsGame[action] {
					reason += "; this action needs the game running and BlBridge loaded"
				}
				return fmt.Sprintf("report_type: bridge_query\naction: %s\nexit_code: 2\nerror: %s\n",
					action, reason), nil
			}
			if strings.Contains(err.Error(), "executable file not found") ||
				strings.Contains(err.Error(), "cannot find the file") {
				lastErr = "interpreter not found: " + interpreter
				continue
			}
			// A non-zero exit is the CLI REPORTING a failure, not a launch problem, so its
			// output is the answer and is returned rather than replaced by an error.
		}

		text := string(out)
		var b strings.Builder
		fmt.Fprintf(&b, "report_type: bridge_query\naction: %s\n", action)
		fmt.Fprintf(&b, "needs_running_game: %t\n", bridgeNeedsGame[action])
		fmt.Fprintf(&b, "exit_code: %d\n", cmd.ProcessState.ExitCode())
		if text == "" {
			// Silence is not a result. Saying so beats returning an empty report that reads
			// like a successful call with nothing to report.
			b.WriteString("note: the Bridge CLI produced no output\n")
		} else {
			b.WriteString("\noutput:\n")
			for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
				fmt.Fprintf(&b, "  %s\n", line)
			}
		}
		b.WriteString("\nnotes:\n")
		b.WriteString("  Runs the Bridge CLI as a subprocess; no shared code crosses the module boundary.\n")
		b.WriteString("  Pair with check_mod_conflicts: source declares what should attach, this reports what did.\n")
		return b.String(), nil
	}

	return fmt.Sprintf("report_type: bridge_query\naction: %s\nerror: %s\n", action, lastErr), nil
}
