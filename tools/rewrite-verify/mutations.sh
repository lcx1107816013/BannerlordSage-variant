#!/usr/bin/env bash
# Reverse-validation for the utils differential harness.
#
# An assertion that cannot fail is not evidence, so each injected defect below is
# expected to turn diff_utils_units.mjs red. The code is restored from a copy after
# every injection, and the script re-runs the clean harness at the end, so a
# surviving mutation can never quietly remain in the working tree.
#
# usage: bash tools/rewrite-verify/mutations.sh
set -u

BUN="C:/Users/LCGX/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe/bun-windows-x64/bun.exe"
REPO=/d/GitHub/BannerlordSage-variant
TMP=/tmp/blore-mutation
mkdir -p "$TMP"
cd "$REPO" || exit 1

inject() { "$BUN" tools/rewrite-verify/inject.mjs "$@"; }
restore() { cp "$TMP/$(basename "$1")" "$1"; }
save() { cp "$1" "$TMP/$(basename "$1")"; }

# Print how many mismatches the harness reports; 0 means the mutation survived.
count_mismatches() { "$BUN" tools/rewrite-verify/diff_utils_units.mjs 2>&1 | grep -cE '^MISMATCH'; }

expected_red=0
survived=0

check() {
  local label="$1" file="$2" find="$3" repl="$4"
  save "$file"
  if ! inject "$file" "$find" "$repl"; then
    echo "COMPILE/SETUP-FAIL  $label  (pattern not found - injection did not happen)"
    restore "$file"
    return
  fi
  local n
  n=$(count_mismatches)
  restore "$file"
  if [ "$n" -gt 0 ]; then
    echo "CAUGHT        ($n mismatch)  $label"
    expected_red=$((expected_red + 1))
  else
    echo "SURVIVED      (enumerate a case where it differs, or mark EQUIVALENT)  $label"
    survived=$((survived + 1))
  fi
}

check "env: normalizeGameId stops lowercasing" \
  src/utils/env.ts "gameId?.trim().toLowerCase()" "gameId?.trim()"
check "env: env-key precedence inverted" \
  src/utils/env.ts "const GAME_ID_ENV_KEYS = ['BANNERSAGE_GAME', 'BANNERLORDSAGE_GAME'] as const" \
  "const GAME_ID_ENV_KEYS = ['BANNERLORDSAGE_GAME', 'BANNERSAGE_GAME'] as const"
# ★ NOT INJECTED - EQUIVALENT, on an enumerated argument rather than a guess.
#   activeGameId is imported at module load and no unit below ever reassigns the
#   env, so `getActiveGameId()` and the already-resolved `activeGamePaths.gameId`
#   read the same variable in the same process. The two spellings can only
#   diverge if something mutates process.env AFTER import, which no consumer does.
#   Recorded rather than deleted, so the survival number is not laundered.
echo "EQUIVALENT    (enumerated: no consumer mutates BANNERSAGE_GAME after import)  env: activeGameId re-reads the env"
check "ai-text: multiline emptiness tested on the raw value, not the trimmed one" \
  src/utils/ai-text.ts "    if (!body) {" "    if (!field.value) {"
check "ai-text: 'unknown' fallback lost on blank scalars" \
  src/utils/ai-text.ts "  return isEmpty ? fallback : rendered" "  return rendered"
# ★ NOT INJECTED - EQUIVALENT, on an enumerated argument rather than a guess.
#   The arm is guarded by `typeof value === 'boolean'`, so its entire input
#   domain is {true, false}. On that domain `v ? 'a' : 'b'` and `v && 'a' || 'b'`
#   agree for both members, and no third value can reach the line. Recorded
#   rather than deleted, so the survival number is not laundered.
echo "EQUIVALENT    (enumerated: domain is typeof===boolean, i.e. {true,false})  ai-text: boolean arm written as && ||"
check "api-docs: version parts truncated to two" \
  src/utils/bannerlord-api-docs.ts "parts.slice(0, API_VERSION_PART_COUNT)" "parts.slice(0, 2)"
check "api-docs: exact match ignores the installed side" \
  src/utils/bannerlord-api-docs.ts "  return candidate === installed" "  return Boolean(candidate)"
check "api-docs: version comparison clamps to 0 instead of reading the parts" \
  src/utils/bannerlord-api-docs.ts "    const leftValue = leftParts[slot] || 0" "    const leftValue = 0"
check "api-docs: newest-first sort applied as oldest-first" \
  src/utils/bannerlord-api-docs.ts "  return compareApiVersions(right, left)" "  return compareApiVersions(left, right)"
# ★ NOT INJECTED - EQUIVALENT, and the enumeration lives in the harness itself:
#   diff_utils_units.mjs asserts that no prefix set passed by any call site in
#   this repo has one entry that is a proper prefix of another. Without such a
#   pair, the first match IS the last match. The harness fails loudly if that
#   assertion stops holding, so this equivalence cannot silently expire.
echo "EQUIVALENT    (enumerated: no call-site prefix set nests - asserted in the harness)  entity-resolver: find -> findLast"
check "mod-source: workspace id case-fold removed" \
  src/utils/mod-source.ts ".toLowerCase()" ".toUpperCase()"
check "mod-source: workspace id truncated to 13 hex" \
  src/utils/mod-source.ts "slice(0, 12)" "slice(0, 13)"
check "mod-source: ignored-directory test loses its trim" \
  src/utils/mod-source.ts "IGNORED_DIRECTORY_LOOKUP.has(name.trim().toLowerCase())" \
  "IGNORED_DIRECTORY_LOOKUP.has(name.toLowerCase())"
check "mod-source: skip list stops matching (Set built from a filtered list)" \
  src/utils/mod-source.ts "new Set(MOD_SOURCE_IGNORED_DIRECTORY_NAMES)" \
  "new Set(MOD_SOURCE_IGNORED_DIRECTORY_NAMES.filter(n => n !== 'bin'))"
check "mod-source: nested-src rule inverted (bare root always wins)" \
  src/utils/mod-source.ts "  const isAlreadySourceRoot = basename(workspaceRoot).toLowerCase() === 'src'" \
  "  const isAlreadySourceRoot = false"
check "mod-source: nested-src probe tests existence, not directory-ness" \
  src/utils/mod-source.ts "if (nestedStats?.isDirectory()) {" "if (nestedStats) {"
check "mod-source: 'not a directory' guard removed" \
  src/utils/mod-source.ts "  if (!workspaceStats?.isDirectory()) {" "  if (false) {"
check "ai-text: the blank-line rule between blocks inverts" \
  src/utils/ai-text.ts "    if (index !== lastBlockIndex) {" "    if (index > lastBlockIndex) {"
# ★ NOT INJECTED - EQUIVALENT, on an enumerated argument rather than a guess.
#   activeGameId is imported at module load and no consumer mutates
#   BANNERSAGE_GAME afterwards, so `getActiveGameId()` and the already-resolved
#   `activeGamePaths.gameId` read the same variable in the same process. The two
#   spellings can only diverge if something reassigns process.env AFTER import.
echo "EQUIVALENT    (enumerated: no consumer mutates the game-id env after import)  env: activeGameId re-reads the env"

echo
echo "caught: $expected_red   survived: $survived"
echo
echo "--- working tree restored; clean harness must be green ---"
git status --short src/utils/
"$BUN" tools/rewrite-verify/diff_utils_units.mjs 2>&1 | tail -1
