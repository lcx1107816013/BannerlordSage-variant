// The blore MCP server entrypoint — the Go mirror of src/stdio.ts.
//
// Startup order mirrors the TypeScript exactly:
//
//  1. bailWhenUninitialized(): when the active game's index is not ready, print the
//     fix-up checklist to STDERR and exit(1) BEFORE binding the transport. A client
//     that connects to an uninitialized index would see tools that all fail on a
//     missing database, which is worse than a loud startup failure.
//  2. connect the StdioTransport
//  3. log "BannerlordSage MCP is ready and waiting for a client connection." to STDERR
//     (stdout is the protocol channel; anything else there corrupts the framing)
//  4. on SIGINT/SIGTERM: close the cached database handles and exit 0
package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/env"
	"blore/internal/registry"
	"blore/internal/report"
	"blore/internal/runtimecheck"
	"blore/internal/store"
	"blore/internal/toolset"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "Fatal startup error:", err)
		os.Exit(1)
	}
}

func run() error {
	if err := bailWhenUninitialized(); err != nil {
		return err
	}

	deps := &registry.Deps{
		OpenGameDB: func() (*sql.DB, error) {
			paths := env.GetGamePaths(env.ActiveGameID())
			return store.OpenDB(paths.DBPath)
		},
		OpenMemoryDB: func() (*sql.DB, error) {
			paths := env.GetGamePaths(env.ActiveGameID())
			return store.OpenMemoryDB(paths.MemoryDBPath)
		},
		ToolsetMode: toolset.GetMode(os.LookupEnv),
	}
	server := registry.NewServer(deps)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go func() {
		<-ctx.Done()
		fmt.Fprintln(os.Stderr, "Shutting down BannerlordSage...")
		store.CloseAll()
	}()

	fmt.Fprintln(os.Stderr, "BannerlordSage MCP is ready and waiting for a client connection.")
	return server.Run(ctx, &mcp.StdioTransport{})
}

// bailWhenUninitialized mirrors bailWhenUninitialized in src/stdio.ts: the bannerlord
// profile requires source, XML and the SQLite index, and a server that starts without
// them is a server whose every tool call would fail late. The printed lines double as
// the operator's fix-up checklist, so their wording is part of the contract.
func bailWhenUninitialized() error {
	paths := env.GetGamePaths(env.ActiveGameID())

	// The bannerlord profile requires all three artifacts (requiresSource,
	// requiresXml, requiresDb are all true in game-profiles.ts).
	readiness, err := runtimecheck.GetReadiness(env.ActiveGameID(),
		runtimecheck.Requires{Source: true, XML: true, DB: true},
		paths.SourcePath, paths.DefsPath, paths.DBPath)
	if err != nil {
		return err
	}
	if readiness.Ready {
		return nil
	}

	status, err := runtimecheck.GetStatus(env.ActiveGameID(),
		runtimecheck.Requires{Source: true, XML: true, DB: true},
		paths.SourcePath, paths.DefsPath, paths.DBPath)
	if err != nil {
		return err
	}

	dbPresent := "no"
	if status.DBExists {
		dbPresent = "yes"
	}
	fmt.Fprintln(os.Stderr, "BannerlordSage has not been initialized yet.")
	fmt.Fprintln(os.Stderr, "- Active game profile: "+status.GameID)
	fmt.Fprintf(os.Stderr, "- Decompiled source files: %d\n", status.SourceFiles)
	fmt.Fprintf(os.Stderr, "- Imported XML files: %d\n", status.XMLFiles)
	fmt.Fprintln(os.Stderr, "- SQLite index present: "+dbPresent)
	fmt.Fprintln(os.Stderr)
	fmt.Fprintf(os.Stderr, "Run `bun run setup -- --game %s` first to import game assets, decompile DLLs, and build the indexes.\n", status.GameID)

	// The TypeScript calls process.exit(1) here; returning a distinct error keeps the
	// same exit code (main maps any error to exit 1) while letting run() own the flow.
	return errUninitialized{gameID: status.GameID}
}

type errUninitialized struct{ gameID string }

func (e errUninitialized) Error() string {
	return "BannerlordSage has not been initialized yet (game: " + report.TrimJS(e.gameID) + ")"
}
