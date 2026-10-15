// Package policyid mirrors src/utils/bannerlord-policy-id.ts: it canonicalises the several ways
// a Bannerlord policy id is written in game data into the single form the index stores.
package policyid

import "strings"

// policyIDAliases mirrors POLICY_ID_ALIASES. The single entry here is a real data defect in the
// game files, not a convenience: the policy is spelled `..._grands_for_veteran` in some places
// and `..._grants_for_veterans` in the index, so lookups must map the former onto the latter.
var policyIDAliases = map[string]string{
	"policy_land_grands_for_veteran": "policy_land_grants_for_veterans",
}

// Normalize mirrors normalizeBannerlordPolicyId.
//
// ★ THE ORDER OF OPERATIONS IS LOAD-BEARING: trim, then strip a leading `Policy.`, then
// LOWERCASE, then alias. Doing the lowercase first would still strip the prefix — because the
// prefix test is case-INsensitive — but aliasing before lowercasing would fail to match the
// (already lowercase) alias keys, since game data writes the id with capitals.
//
// ★ The prefix test is case-insensitive (`/^Policy\./i`), so `POLICY.Foo`, `policy.foo` and
// `PoLiCy.Foo` all have the prefix removed while `Policy_Foo` (underscore, not a dot) does not.
// A port that used a case-sensitive prefix would leave the capitals in place and query a key
// that does not exist.
//
// ★ Empty results are treated as absent: both the initial empty input and an input that is
// nothing but the prefix (`"Policy."`) collapse to `""` and return ok=false. A bare `"."` does
// NOT: no prefix matches, so it lowercases to `"."` and is returned as a real (if useless) id.
func Normalize(value string) (string, bool) {
	if value == "" {
		return "", false
	}

	trimmed := strings.TrimSpace(value)

	if len(trimmed) >= len("policy.") {
		if strings.EqualFold(trimmed[:len("policy.")], "policy.") {
			trimmed = trimmed[len("policy."):]
		}
	}

	normalized := strings.ToLower(trimmed)
	if normalized == "" {
		return "", false
	}

	if aliased, ok := policyIDAliases[normalized]; ok {
		return aliased, true
	}
	return normalized, true
}
