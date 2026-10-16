//go:build !windows

package parity_test

import "errors"

// createJunction has no non-Windows equivalent: a junction is a Windows reparse point. The callers
// SKIP when this returns an error, which is why the rule is also recorded as a measured A/B in the
// walker's own comment rather than only living in a test that cannot run everywhere.
func createJunction(link, target string) error {
	return errors.New("directory junctions are a Windows concept")
}
