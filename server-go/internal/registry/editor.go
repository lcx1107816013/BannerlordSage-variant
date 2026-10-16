package registry

import (
	"encoding/json"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"blore/internal/toolnaming"
)

// schema builds a raw JSON-schema object for a tool input, the Go mirror of the TS
// `inputSchema: { ... zod descriptors ... }` blocks.
//
// ★ RAW JSON, NOT INFERRED. The TypeScript writes every property, description, enum and
// default by hand in src/server.ts. Inferring from a Go struct would drop the
// descriptions and reshape the enums, and the input schema is client-visible surface —
// a client that reads `intent: enum [...]` from the TS server must read the same enum
// here. json.RawMessage goes through mcp.Server.AddTool's "raw" path: it marshals to a
// valid object schema and validation stays the caller's job, which is exactly how the
// TS tools behave (they validate inside their bodies, not via the SDK).
func schema(v any) json.RawMessage {
	raw, err := json.Marshal(v)
	if err != nil {
		// A map[string]any built from literals in this package cannot fail to marshal;
		// panicking keeps a silent empty schema from ever being advertised.
		panic(err)
	}
	return raw
}

// prop builds one property descriptor.
func prop(typ, description string) map[string]any {
	return map[string]any{"type": typ, "description": description}
}

// propWithDefault builds one property descriptor with a default value, mirroring
// zod's `.default(x)`.
func propWithDefault(typ string, def any, description string) map[string]any {
	return map[string]any{"type": typ, "default": def, "description": description}
}

// enumPropDefault builds a string-enum property carrying a DEFAULT, mirroring
// z.enum([...]).optional().default(x). The default is part of the contract: a client
// that omits the field must be told which value it will receive.
func enumPropDefault(values []string, def string, description string) map[string]any {
	anyValues := make([]any, len(values))
	for i, v := range values {
		anyValues[i] = v
	}
	return map[string]any{
		"type":        "string",
		"enum":        anyValues,
		"default":     def,
		"description": description,
	}
}

// propConstrained builds a string property with min/max LENGTH, mirroring
// z.string().min(n).max(m) — the shape the TS gives sessionPath. JSON Schema's length
// bounds are minLength/maxLength; numeric minimum/maximum would be a different claim.
func propConstrained(typ string, minLen, maxLen int, description string) map[string]any {
	return map[string]any{
		"type":        typ,
		"minLength":   minLen,
		"maxLength":   maxLen,
		"description": description,
	}
}

// enumProp builds a string-enum property, mirroring z.enum([...]).
func enumProp(values []string, description string) map[string]any {
	anyValues := make([]any, len(values))
	for i, v := range values {
		anyValues[i] = v
	}
	return map[string]any{"type": "string", "enum": anyValues, "description": description}
}

// register adds one tool with a fixed result-producing handler. Name and handler are
// built from the LEGACY name through the same archiveToolName the TS registration uses.
func register(server *mcp.Server, legacyName, title, description string, annotations *mcp.ToolAnnotations, inputSchema map[string]any, handler mcp.ToolHandler) {
	server.AddTool(&mcp.Tool{
		Name:        toolnaming.ArchiveToolName(legacyName),
		Title:       title,
		Description: description,
		Annotations: annotations,
		InputSchema: schema(inputSchema),
	}, handler)
}

// ─────────────────────────────────────────────────────────────────────────────
// Editor tools — src/tools/bannerlord-editor.ts
//
// bannerlord_editor_status is registered in BOTH modes; the other five only in 'full'.
// None of the six has a Go body: they depend on bannerlord-editor-client.ts, which talks
// to the blbridge C# EditorProbe over a session file. All six carry the shared
// sessionPath parameter (z.string().min(1).max(4096).optional()).
// ─────────────────────────────────────────────────────────────────────────────

func registerEditorTools(server *mcp.Server, _ *Deps) {
	// sessionPath mirrors the TS zod: z.string().min(1).max(4096).optional().
	// ★ NO DEFAULT. An earlier version used propWithDefault(.., nil, ..), which emitted
	// `"default": null` — a value the TS never advertises. The surface classifier caught
	// it on all six editor tools.
	sessionPath := propConstrained("string", 1, 4096, "Optional absolute path to the local editor bridge session JSON; defaults to BANNERSAGE_EDITOR_PROBE_SESSION.")

	statusSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"sessionPath": sessionPath},
	}
	register(server, "bannerlord_editor_status", "Bannerlord Editor Status",
		"Inspect the configured local editor bridge, version alignment and active scene. Returns a diagnostic when the bridge is unconfigured or disconnected.",
		readOnly(), statusSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_status"))))
}

func registerAuthoringEditorTools(server *mcp.Server) {
	// sessionPath mirrors the TS zod: z.string().min(1).max(4096).optional().
	// ★ NO DEFAULT. An earlier version used propWithDefault(.., nil, ..), which emitted
	// `"default": null` — a value the TS never advertises. The surface classifier caught
	// it on all six editor tools.
	sessionPath := propConstrained("string", 1, 4096, "Optional absolute path to the local editor bridge session JSON; defaults to BANNERSAGE_EDITOR_PROBE_SESSION.")

	entitiesSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"sessionPath": sessionPath},
	}
	register(server, "bannerlord_editor_entities", "Bannerlord Editor Managed Entities",
		"Read the managed layout objects in the active configured scene, including stable IDs, prefabs, GUIDs and transforms.",
		readOnly(), entitiesSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_entities"))))

	prefabSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"sessionPath": sessionPath,
			"prefab":      map[string]any{"type": "string", "minLength": 1, "maxLength": 128},
			"mesh":        map[string]any{"type": "string", "minLength": 1, "maxLength": 128},
		},
		"required": []string{"prefab"},
	}
	register(server, "bannerlord_editor_prefab_info", "Bannerlord Editor Prefab Info",
		"Check a Native prefab in the active configured scene and read mesh bounds when available. Does not instantiate objects.",
		readOnly(), prefabSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_prefab_info"))))

	// The layout entity array carries a per-entity regex and numeric bounds plus a
	// unique-id superRefine; the full zod shape is reproduced so a client that
	// validates locally sees the same contract the TS server advertised.
	layoutEntity := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"id": map[string]any{"type": "string", "pattern": "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$"},
			"prefab": map[string]any{
				"type": "string", "minLength": 1, "maxLength": 128,
			},
			"x":  map[string]any{"type": "number", "minimum": -100, "maximum": 100},
			"y":  map[string]any{"type": "number", "minimum": -100, "maximum": 100},
			"z":  map[string]any{"type": "number", "minimum": -100, "maximum": 100},
			"rx": map[string]any{"type": "number", "minimum": -3600, "maximum": 3600},
			"ry": map[string]any{"type": "number", "minimum": -3600, "maximum": 3600},
			"rz": map[string]any{"type": "number", "minimum": -3600, "maximum": 3600},
			"sx": map[string]any{"type": "number", "minimum": 0.05, "maximum": 20},
			"sy": map[string]any{"type": "number", "minimum": 0.05, "maximum": 20},
			"sz": map[string]any{"type": "number", "minimum": 0.05, "maximum": 20},
		},
		"required":             []string{"id", "prefab", "x", "y", "z"},
		"additionalProperties": false,
	}
	applyLayoutSchema := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"sessionPath": sessionPath,
			"entities": map[string]any{
				"type":     "array",
				"items":    layoutEntity,
				"minItems": 1,
				"maxItems": 64,
			},
		},
		"required": []string{"entities"},
	}
	register(server, "bannerlord_editor_apply_layout", "Bannerlord Editor Apply Layout",
		"Create or update up to 64 managed prefab roots in the active configured scene. Repeated IDs preserve objects and GUIDs; prefab conflicts are rejected. This changes the scene in memory; call save_scene explicitly to persist it.",
		writableDestructiveFalseIdempotent(), applyLayoutSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_apply_layout"))))

	saveSchema := map[string]any{
		"type":       "object",
		"properties": map[string]any{"sessionPath": sessionPath},
	}
	register(server, "bannerlord_editor_save_scene", "Bannerlord Editor Save Scene",
		"Save the active configured dedicated scene. Does not close, replace or reload the scene.",
		writableIdempotent(), saveSchema, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_save_scene"))))

	register(server, "bannerlord_editor_capture", "Bannerlord Editor Capture",
		"Return the native editor screenshot as a PNG image plus metadata. Captures its current view without moving the camera, changing scene metadata or reloading.",
		readOnly(), map[string]any{
			"type":       "object",
			"properties": map[string]any{"sessionPath": sessionPath},
		}, stubHandler(notImplemented(toolnaming.ArchiveToolName("bannerlord_editor_capture"))))
}
