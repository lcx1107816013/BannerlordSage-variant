#!/usr/bin/env bash
# Regenerate every parity fixture and diff it against the frozen golden copy.
# Usage: tools/utils-rewrite-verify.sh [gen_name ...]   (default: all)
set -u

BUN="C:/Users/LCGX/AppData/Local/Microsoft/WinGet/Packages/Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe/bun-windows-x64/bun.exe"
REPO=/d/GitHub/BannerlordSage-variant
GOLD=/d/Documents/_golden
PARITY="$REPO/server-go/tools/parity"

cd "$REPO" || exit 1

if [ "$#" -gt 0 ]; then
  GENS=("$@")
else
  GENS=()
  for f in "$PARITY"/gen_*_fixtures.mjs; do
    GENS+=("$(basename "$f")")
  done
fi

fail=0
for g in "${GENS[@]}"; do
  # Accept either the file name (gen_x_fixtures.mjs) or the short unit name (x).
  case "$g" in
    gen_*_fixtures.mjs) ;;
    resolveloc) g="gen_resolvelocalization_fixtures.mjs" ;;
    *) g="gen_${g}_fixtures.mjs" ;;
  esac
  name="${g#gen_}"
  name="${name%_fixtures.mjs}"
  case "$name" in
    resolvelocalization) out="resolveloc" ;;
    *) out="$name" ;;
  esac

  # Some generators own a committed sidecar database and refuse to overwrite it.
  # Save a hash, let the generator rebuild it, and prove it came back identical.
  sidecar=""
  sidecar_hash_before=""
  pre_rm=()
  case "$name" in
    resolvelocalization)
      sidecar="$PARITY/fixtures/resolveloc.db"
      pre_rm=("$sidecar")
      ;;
  esac
  for path in "${pre_rm[@]:-}"; do
    [ -z "$path" ] && continue
    sidecar_hash_before=$(sha256sum "$path" 2>/dev/null | cut -d' ' -f1)
    rm -f "$path"
  done

  gen_out=$("$BUN" "server-go/tools/parity/$g" 2>&1)
  gen_rc=$?
  if [ $gen_rc -ne 0 ]; then
    # ★ No exemption list here any more, on purpose. This used to special-case
    #   modsourceindex, which could not run on a fresh clone (its DELETE preceded its
    #   CREATE, so it died on "no such table" before reaching any TypeScript). That was
    #   fixed at the generator in 12933ab, and the workaround is gone because a
    #   PRE-EXISTING carve-out for a generator that fails is exactly the kind of
    #   permanent excuse that would hide the NEXT failure too. Verify it stays fixed:
    #     rm -rf dist/mod-sources && bun server-go/tools/parity/gen_modsourceindex_fixtures.mjs
    echo "GEN-FAIL  $g (rc=$gen_rc)"
    echo "$gen_out" | tail -5
    fail=1
    continue
  fi

  actual="$PARITY/${out}_fixtures.json"
  expect="$GOLD/${out}_fixtures.json"
  if [ ! -f "$expect" ]; then
    echo "NO-GOLDEN $out"
    continue
  fi
  if [ ! -f "$actual" ]; then
    echo "NO-OUTPUT $out"
    fail=1
    continue
  fi

  if diff -q "$expect" "$actual" >/dev/null 2>&1; then
    echo "OK        $out"
  else
    echo "DIFF-FAIL $out"
    diff "$expect" "$actual" | head -20
    fail=1
  fi

  if [ -n "$sidecar" ]; then
    sidecar_hash_after=$(sha256sum "$sidecar" 2>/dev/null | cut -d' ' -f1)
    if [ "$sidecar_hash_before" = "$sidecar_hash_after" ]; then
      echo "OK        $(basename "$sidecar") byte-identical after rebuild"
    else
      echo "SIDE-FAIL $(basename "$sidecar") changed: $sidecar_hash_before -> $sidecar_hash_after"
      fail=1
    fi
  fi
done

if [ $fail -eq 0 ]; then
  echo "=== ALL GREEN ==="
else
  echo "=== FAILURES PRESENT ==="
fi
exit $fail
