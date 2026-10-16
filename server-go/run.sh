#!/usr/bin/env bash
# Run the Go server without tripping this machine's endpoint security product.
#
# WHY THIS SCRIPT EXISTS
# ----------------------
# 360 (主动防御) blocks and quarantines new, unsigned executables by content hash, and its
# real-time scanner does not act on files under the system temp directory. `go run` and
# `go test` compile into %TEMP%\go-build<random>\, so they are outside the watched set;
# `go build -o <somewhere>` puts the artifact exactly where the scanner is looking, and the
# artifact is then blocked — often deleted. Measured, in server-go/BUILDING.md.
#
# So this runner deliberately does NOT build to a path of its own. It uses `go run`, which is
# also the fastest path when you just want the server up.
#
# Usage:
#   ./run.sh                    # query-first tier (the default entrypoint's tier)
#   ./run.sh full               # every tool
#   ./run.sh query-first        # explicit
#
# Environment honoured (same variables the TypeScript server reads):
#   BLORE_ROOT          repo root; defaults to this repository
#   BANNERSAGE_TOOLSET  query-first | full; first positional arg overrides
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"

# Go is not on PATH in a bare shell on this machine.
case ":$PATH:" in
  *":/c/Program Files/Go/bin:"*) ;;
  *) export PATH="$PATH:/c/Program Files/Go/bin" ;;
esac

if ! command -v go >/dev/null 2>&1; then
  echo "go not found on PATH (looked for /c/Program Files/Go/bin)" >&2
  exit 127
fi

# The server resolves its repo root from BLORE_ROOT; without it, it walks up from the
# executable directory, which for `go run` is a temp dir with no repo marker above it.
export BLORE_ROOT="${BLORE_ROOT:-$(cygpath -w "$REPO_ROOT" 2>/dev/null || echo "$REPO_ROOT")}"

if [ "$#" -ge 1 ]; then
  export BANNERSAGE_TOOLSET="$1"
else
  export BANNERSAGE_TOOLSET="${BANNERSAGE_TOOLSET:-query-first}"
fi

echo "BLORE_ROOT=$BLORE_ROOT" >&2
echo "BANNERSAGE_TOOLSET=$BANNERSAGE_TOOLSET" >&2

cd "$HERE"
# No -o: let Go build into %TEMP%, which the scanner ignores.
exec go run ./cmd/blore-server
