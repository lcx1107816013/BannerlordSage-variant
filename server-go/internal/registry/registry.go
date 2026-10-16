// Package registry wires the ported tool bodies onto an MCP server, mirroring
// src/server.ts's registration surface.
//
// ★ THE CONTRACT THIS FILE CARRIES
//
// Every tool name comes from toolnaming.ArchiveToolName applied to its LEGACY name — the
// same helper the TypeScript registers with — so this file cannot hand-write a current
// name and drift from the advertised surface (the exact failure mode of finding F1: 16
// tools once silently unregistered).
//
// ★ NOT SILENTLY FEWER
//
// The TypeScript registers 46 tools (39 query-first + 7 authoring, the latter only in
// 'full' mode). This file registers ALL of them. A tool whose Go body exists is bound to
// it; the rest are bound to an explicit not-implemented answer. The alternative —
// registering only the ported ~20 — is the "quietly 16 fewer tools" bug again, in the
// other direction, and against the handover's explicit instruction.
//
// ★ NOT-IMPLEMENTED IS A TOOL ANSWER, NOT AN ABSENCE
//
// The stub returns a text block that names the tool and states the Go port is pending,
// so a client enumerating tools sees the full surface and a caller invoking an unported
// tool gets an honest answer instead of a protocol error. The wording is fixed and
// greppable ("not yet ported to the Go server").
package registry

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/buildinfo"
	"blore/internal/mcputil"
)

// sqlDB aliases *sql.DB for the Deps fields below.
type sqlDB = sql.DB

// Deps carries everything the tool handlers need. It is built once by the server
// skeleton (cmd/blore-server) and handed to every registration, mirroring the module
// state src/server.ts closes over (the sandbox, the cached db handles, the toolset mode).
//
// ★ DBHandle IS *sql.DB. The named interface exists only so this package does not import
// database/sql; *sql.DB satisfies it structurally (QueryRow returns *sql.Row, which has
// Scan). When a handler needs Query/Exec, widen the interface here rather than importing
// sql into registry — one place defines what tools may do to a database.
type Deps struct {
	// OpenGameDB mirrors getDb(): a writable cached connection that drops itself when
	// the runtime revision changes. Callers supply the opener; registry never resolves
	// paths itself.
	OpenGameDB func() (*sqlDB, error)
	// OpenMemoryDB mirrors getMemoryDb().
	OpenMemoryDB func() (*sqlDB, error)
	// Toolset mode: "query-first" or "full" (toolset.ModeFull / ModeQueryFirst).
	ToolsetMode string
}

// NewServer builds the MCP server with the full registered surface.
//
// The implementation name and version mirror the TypeScript's
// `new McpServer({ name: 'blore', version: packageJson.version })`.
func NewServer(deps *Deps) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    buildinfo.ServerName,
		Version: buildinfo.Version,
	}, nil)
	registerAll(server, deps)
	return server
}

// textOnly builds the CallToolResult every ported tool returns: one text block, exactly
// the TS tools' `{ content: [{ type: 'text', text }] }` shape.
func textOnly(text string) *mcp.CallToolResult {
	return mcputil.TextResult(text)
}

// notImplemented is the stub for every tool whose Go body has not landed yet.
//
// ★ FIXED WORDING, so the gap is greppable across any client log:
//   "The '<name>' tool is not yet ported to the Go server; run the TypeScript
//    entrypoint for this tool."
func notImplemented(name string) *mcp.CallToolResult {
	return textOnly(fmt.Sprintf("The '%s' tool is not yet ported to the Go server; run the TypeScript entrypoint for this tool.", name))
}

// readOnly mirrors the annotations every query tool declares
// (`{ readOnlyHint: true, openWorldHint: false }`).
func readOnly() *mcp.ToolAnnotations {
	f := false
	return &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: &f}
}

// writable mirrors the write tools' `{ readOnlyHint: false, openWorldHint: false }`.
func writable() *mcp.ToolAnnotations {
	f := false
	r := false
	return &mcp.ToolAnnotations{ReadOnlyHint: r, OpenWorldHint: &f}
}

// registerAll registers the whole surface. The order matches src/server.ts's call order
// (editor registrations first, then the 16 restored gameplay tools, then the main file's
// registrations), because a client that lists tools sees them in registration order and
// the TypeScript's order is the contract clients were built against.
func registerAll(server *mcp.Server, deps *Deps) {
	registerEditorTools(server, deps)
	registerLegacyGameplayTools(server, deps)
	registerMainTools(server, deps)
	if deps.ToolsetMode == "full" {
		registerAuthoringTools(server, deps)
	}
}

// stubHandler adapts a fixed result into a ToolHandler.
func stubHandler(res *mcp.CallToolResult) mcp.ToolHandler {
	return func(_ context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return res, nil
	}
}
