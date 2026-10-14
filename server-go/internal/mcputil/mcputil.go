// Package mcputil holds MCP plumbing shared by tool implementations.
package mcputil

import (
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

// TextResult wraps a plain-text tool answer in a CallToolResult, matching the
// TS tools' `{ content: [{ type: 'text', text }] }` shape.
func TextResult(text string) *mcp.CallToolResult {
	return &mcp.CallToolResult{
		Content: []mcp.Content{&mcp.TextContent{Text: text}},
	}
}

// ToolAnnotations returns the standard read-only annotation used by the TS
// query tools (readOnlyHint: true, openWorldHint: true unless stated).
func ReadOnlyAnnotations() *mcp.ToolAnnotations {
	return &mcp.ToolAnnotations{ReadOnlyHint: true}
}
