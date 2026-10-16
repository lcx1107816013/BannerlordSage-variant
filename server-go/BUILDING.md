# Building and running the Go server on this machine

## Read this first if a build "suddenly stopped working"

If you build the server and Windows refuses to start it — `Access is denied`, `Permission denied`,
or the file vanishing right after `go build` — **nothing is wrong with the code.** It is the
endpoint security product on this machine, and the cause is fully diagnosed below.

**The one-line fix: do not pass `-o <your own path>`. Use `go run`, or `./run.sh`.**

```bash
go run ./cmd/blore-server          # correct: builds into %TEMP%, which the AV ignores
./run.sh                           # same, with the environment pre-set
go test ./...                      # same: go test also builds into %TEMP%
```

---

## The diagnosis (measured, not inferred)

Three observations, each reproduced:

| Observation | Evidence |
|---|---|
| A freshly compiled `.exe` written to a user-chosen path is **blocked**, then **deleted** | `go build -o D:/Documents/_avtest/hello.exe` → first run denied, file gone on the next check |
| The same BYTES copied to another new path **run fine** | `cp` of an already-executed binary to a fresh directory executed normally |
| `go run` and `go test` **work reliably** | three consecutive runs of each, then again after wiping the build cache **and changing the source** (new hash) |

The security product is 360 (主动防御 `ZhuDongFangYu.exe` + `360tray.exe`; Windows Defender is
disabled on this box — `Get-MpPreference` returns `0x800106ba`). It blocks and quarantines new,
unsigned executables by **content hash**, and its real-time scanner **does not act on files under
the system temp directory**.

That last point is the whole fix. `go run` and `go test` compile into `%TEMP%\go-build<random>\`,
so they are outside the watched set. `go build -o <somewhere>` puts the artifact exactly where the
scanner is looking.

### Why this never happened with the TypeScript side

`bun.exe` is a single WinGet-installed binary whose bytes never change. Editing TypeScript sources
does not produce a new executable, so the hash the AV learned once stays valid forever. **Every Go
source change produces a new hash** — which is why this looked like a Go problem and is not one.
Any language whose build step emits a fresh native binary would behave the same way.

### Recorded dead ends

Tested and rejected, so nobody repeats them:

- **`-o` to a fixed path** — does not help. Overwriting a previously-allowed path with a
  *rebuilt* binary produced a new hash and was blocked immediately. An earlier apparent success
  was luck: the rebuild happened to be byte-identical.
- **A `bin/` directory inside the repo** — blocked, and the artifact was deleted.
- **Renaming the extension** (`.dll`, no extension) — blocked; the scanner reads the PE header,
  not the name.
- **`-trimpath -ldflags=-buildid=`** — makes the build *deterministic* (verified: two builds of
  the same source produced identical MD5s), but determinism does not help, because the problem is
  "a hash the scanner has never seen", and every source change creates one.

### If a build is blocked anyway

Rebuild into temp (`go run` / `go test` — no `-o`). If a stale quarantined file is in the way,
delete it and rebuild; a quarantined path stays unusable until the file is replaced.

---

## Normal commands

```bash
export PATH="$PATH:/c/Program Files/Go/bin"

go build ./...                     # compile check, no artifact written
go vet ./...
go test ./... -count=1             # full suite (builds into %TEMP%)
go run ./cmd/blore-server          # run the server on stdio
```

`go build ./...` (no `-o`) only type-checks and discards the binaries, so it is always safe.

## Running against the real index

The server is a standalone executable, so it cannot derive the repo root from its own source
location the way the TypeScript does via `import.meta.dir`. Point it at the checkout explicitly:

```bash
BLORE_ROOT="D:/GitHub/BannerlordSage-variant" go run ./cmd/blore-server
```

`BANNERSAGE_TOOLSET=query-first` or `full` selects the tool tier, the same variable the
TypeScript reads.

## When you genuinely need a file on disk

There are two real cases, and neither is for day-to-day work:

1. **Wiring the server into an MCP client's config.** The client needs a stable path to launch.
   Build it once, and if the AV blocks that path, add the containing directory to the security
   product's trust list — a one-time, user-side action. This document deliberately does not
   automate that: modifying an endpoint security product's configuration is the operator's
   decision, not a build script's.
2. **Measuring the tool surface.** `make surface` in `D:/Documents/BannerScribe` needs a real
   binary; see that Makefile for how it handles the path.

Everything else — development, tests, parity runs — goes through `go run` / `go test` and never
touches the watched paths.
