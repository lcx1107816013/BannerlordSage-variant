// Package buildinfo carries the server version. It must stay in sync with
// package.json (version 0.3.0 at the time of writing); release builds can
// override it with:
//
//	go build -ldflags "-X blore/internal/buildinfo.Version=x.y.z"
package buildinfo

var Version = "0.3.0"

// ServerName is the MCP server identifier ("blore", per the 2026-10-14
// renaming decision).
const ServerName = "blore"
