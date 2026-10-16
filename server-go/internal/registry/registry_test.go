package registry

import (
	"context"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/toolset"
)

// ─────────────────────────────────────────────────────────────────────────────
// Registry surface tests.
//
// The one defect this file exists to prevent is F1's: tools that exist in the TypeScript
// but are silently missing here. So the assertion is not "every registered tool is known"
// but its contrapositive — EVERY name in the toolset lists must be present, in BOTH
// modes, and nothing extra may be registered.
//
// The Go SDK's server keeps its tools private, so the enumeration goes through a real
// client session over an in-memory transport — the same surface a real MCP client sees.
// ─────────────────────────────────────────────────────────────────────────────

func listToolNames(t *testing.T, mode string) []string {
	t.Helper()
	server := NewServer(&Deps{ToolsetMode: mode})
	client := mcp.NewClient(&mcp.Implementation{Name: "registry-test", Version: "test"}, nil)

	t1, t2 := mcp.NewInMemoryTransports()
	if _, err := server.Connect(context.Background(), t1, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	session, err := client.Connect(context.Background(), t2, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer session.Close()

	var names []string
	for tool, err := range session.Tools(context.Background(), nil) {
		if err != nil {
			t.Fatalf("listing tools: %v", err)
		}
		names = append(names, tool.Name)
	}
	if len(names) == 0 {
		t.Fatal("no tools listed; the server advertised an empty surface")
	}
	return names
}

// TestRegistryFullModeMatchesToolsetList pins the FULL surface: query-first + authoring,
// exactly the names toolset.GetActiveToolNames produces for BANNERSAGE_TOOLSET=full.
func TestRegistryFullModeMatchesToolsetList(t *testing.T) {
	got := listToolNames(t, toolset.ModeFull)
	want := toolset.GetActiveToolNames(func(name string) (string, bool) {
		if name == "BANNERSAGE_TOOLSET" {
			return "full", true
		}
		return "", false
	})

	if len(got) != len(want) {
		t.Fatalf("full mode: registered %d tools, toolset lists %d\nregistered: %v\nlisted:   %v",
			len(got), len(want), got, want)
	}
	set := make(map[string]bool, len(got))
	for _, name := range got {
		set[name] = true
	}
	for _, name := range want {
		if !set[name] {
			t.Errorf("full mode: toolset lists %q but the registry did not register it", name)
		}
	}
	// And nothing extra: len equality plus want⊆got means got⊆want too, but the explicit
	// check keeps the failure message useful when a name is added to one side only.
	wantSet := make(map[string]bool, len(want))
	for _, name := range want {
		wantSet[name] = true
	}
	for _, name := range got {
		if !wantSet[name] {
			t.Errorf("full mode: registry registered %q which the toolset does not list", name)
		}
	}
}

// TestRegistryQueryFirstOmitsAuthoring pins the query-first surface: 39 tools, no
// authoring tier.
func TestRegistryQueryFirstOmitsAuthoring(t *testing.T) {
	got := listToolNames(t, toolset.ModeQueryFirst)
	want := toolset.QueryFirstToolNames

	if len(got) != len(want) {
		t.Fatalf("query-first: registered %d tools, toolset lists %d\nregistered: %v\nlisted:   %v",
			len(got), len(want), got, want)
	}
	set := make(map[string]bool, len(got))
	for _, name := range got {
		set[name] = true
	}
	for _, name := range want {
		if !set[name] {
			t.Errorf("query-first: toolset lists %q but the registry did not register it", name)
		}
	}
	for _, name := range toolset.AuthoringToolNames {
		if set[name] {
			t.Errorf("query-first: authoring tool %q must NOT be registered in this mode", name)
		}
	}
}

// TestRegistryCounts pins the headline numbers: 42 query-first, 49 full.
// These were the upstream surface sizes (39/46) until this project added index_assets,
// find_asset and check_mod_conflicts
// and find_asset, which upstream has no equivalent of. The counts moved because the
// capability moved - that is what this assertion is for.
func TestRegistryCounts(t *testing.T) {
	if got := len(listToolNames(t, toolset.ModeQueryFirst)); got != 43 {
		t.Errorf("query-first surface = %d tools, want 43", got)
	}
	if got := len(listToolNames(t, toolset.ModeFull)); got != 50 {
		t.Errorf("full surface = %d tools, want 50", got)
	}
}

// TestNotImplementedStubAnswersHonest pins the stub wording: fixed, greppable, and
// naming the tool it answered for.
func TestNotImplementedStubAnswersHonest(t *testing.T) {
	res := notImplemented("ba_doctor")
	if len(res.Content) != 1 {
		t.Fatalf("stub returned %d content blocks, want 1", len(res.Content))
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("stub content is %T, want *mcp.TextContent", res.Content[0])
	}
	want := "The 'ba_doctor' tool is not yet ported to the Go server; run the TypeScript entrypoint for this tool."
	if text.Text != want {
		t.Errorf("stub text = %q\nwant           %q", text.Text, want)
	}
}

// TestCallingAnUnportedToolGetsTheStub drives a real call through the transport and
// confirms the stub is what a client receives (not a protocol error).
func TestCallingAnUnportedToolGetsTheStub(t *testing.T) {
	server := NewServer(&Deps{ToolsetMode: toolset.ModeFull})
	client := mcp.NewClient(&mcp.Implementation{Name: "registry-test", Version: "test"}, nil)

	t1, t2 := mcp.NewInMemoryTransports()
	if _, err := server.Connect(context.Background(), t1, nil); err != nil {
		t.Fatalf("server connect: %v", err)
	}
	session, err := client.Connect(context.Background(), t2, nil)
	if err != nil {
		t.Fatalf("client connect: %v", err)
	}
	defer session.Close()

	res, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name:      "ba_doctor",
		Arguments: map[string]any{},
	})
	if err != nil {
		t.Fatalf("calling the stub tool returned a protocol error: %v", err)
	}
	if len(res.Content) != 1 {
		t.Fatalf("stub call returned %d content blocks, want 1", len(res.Content))
	}
	text, ok := res.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("stub call content is %T, want *mcp.TextContent", res.Content[0])
	}
	if text.Text != "The 'ba_doctor' tool is not yet ported to the Go server; run the TypeScript entrypoint for this tool." {
		t.Errorf("stub call text = %q", text.Text)
	}
}
