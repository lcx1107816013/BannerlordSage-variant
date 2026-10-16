// Policy identifiers arrive in several spellings. They are matched
// case-insensitively, an optional `Policy.` namespace prefix is stripped
// first, and one known upstream typo is mapped onto its canonical spelling so
// callers can pass either form.

/** Upstream typo -> canonical id. */
const POLICY_ID_ALIASES = new Map<string, string>([
  ['policy_land_grands_for_veteran', 'policy_land_grants_for_veterans'],
])

/** Trims, drops a leading `Policy.` in any case, then lowercases. */
function canonicalizePolicyId(raw: string): string {
  return raw.trim().replace(/^Policy\./i, '').toLowerCase()
}

export function normalizeBannerlordPolicyId(value: string | null | undefined): string | null {
  if (!value) {
    return null
  }

  const canonical = canonicalizePolicyId(value)
  if (canonical.length === 0) {
    return null
  }

  const aliased = POLICY_ID_ALIASES.get(canonical)
  return aliased === undefined ? canonical : aliased
}
