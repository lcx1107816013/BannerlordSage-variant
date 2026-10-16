package bannersetup

import (
	"encoding/json"
	"os"

	"blore/internal/env"
)

// LoadSetupStateForGame mirrors loadSetupStateForGame(gameId): read the setup-state JSON
// and merge it over the DEFAULTS `{ version: 2, dlls: {}, xmlFiles: {} }`.
//
// ★ THE MERGE IS THE CONTRACT, and it is one-sided: the parsed file OVERRIDES the defaults
// key-by-key, so a state file missing `dlls` yields an EMPTY map (not undefined), and a
// state file carrying `dlls: null` yields NULL (which replaces the default map!). The
// spread is `{ ...defaults, ...parsed }` — a shallow merge where `parsed` keys win even
// when their values are null. A missing file yields the defaults verbatim.
//
// The Go shape flattens the maps to their LENGTHS where the tools only count them, but
// keeps the raw JSON for the callers that need the keys (bannerlord_index_status counts
// dlls and walks their paths for the missing-DLL check, so both are here).
type SetupStateFile struct {
	Version        int                    `json:"version"`
	InitializedAt  string                 `json:"initializedAt"`
	GameDir        string                 `json:"gameDir"`
	GameVersion    string                 `json:"gameVersion"`
	BuildChangeset string                 `json:"buildChangeset"`
	FullVersion    string                 `json:"fullVersion"`
	VersionSource  string                 `json:"versionSource"`
	DLLScope       string                 `json:"dllScope"`
	XMLScope       string                 `json:"xmlScope"`
	DLLs           map[string]DLLInfo     `json:"dlls"`
	XMLFiles       map[string]XMLFileInfo `json:"xmlFiles"`
}

// DLLInfo mirrors one dlls entry: the keys are forward-slashed, lowercased relative
// paths from the game dir (how collectDllCandidates indexes them).
type DLLInfo struct {
	MD5        string   `json:"md5"`
	SourceFile string   `json:"sourceFile"`
	OutputDir  string   `json:"outputDir"`
	Size       *int64   `json:"size"`
	MtimeMs    *float64 `json:"mtimeMs"`
	UpdatedAt  string   `json:"updatedAt"`
}

// XMLFileInfo mirrors one xmlFiles entry.
type XMLFileInfo struct {
	SourceFile string  `json:"sourceFile"`
	Size       int64   `json:"size"`
	MtimeMs    float64 `json:"mtimeMs"`
	UpdatedAt  string  `json:"updatedAt"`
}

// LoadSetupStateForGame reads the state for one game.
//
// ★ EVERY READ FAILURE IS THE DEFAULTS — a missing file, an unreadable file and an
// unparsable file are indistinguishable, exactly like the TS's single catch. The
// returned state is never nil.
func LoadSetupStateForGame(gameID string) SetupStateFile {
	state := SetupStateFile{
		Version:  2,
		DLLs:     map[string]DLLInfo{},
		XMLFiles: map[string]XMLFileInfo{},
	}

	paths := env.GetGamePaths(gameID)
	raw, err := os.ReadFile(paths.SetupStatePath)
	if err != nil {
		return state
	}

	var parsed SetupStateFile
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return state
	}

	// `{ version: 2, dlls: {}, xmlFiles: {}, ...parsed }`: the parsed fields win.
	// Version is taken from the file too — the TS default exists only for a MISSING file.
	if parsed.Version != 0 {
		state.Version = parsed.Version
	}
	state.InitializedAt = parsed.InitializedAt
	state.GameDir = parsed.GameDir
	state.GameVersion = parsed.GameVersion
	state.BuildChangeset = parsed.BuildChangeset
	state.FullVersion = parsed.FullVersion
	state.VersionSource = parsed.VersionSource
	state.DLLScope = parsed.DLLScope
	state.XMLScope = parsed.XMLScope
	// ★ A FILE KEY THAT IS PRESENT-BUT-NULL REPLACES THE DEFAULT MAP with nil — the
	// spread does not re-default it. Only an ABSENT key keeps the empty map. Unmarshaling
	// cannot distinguish those two cases, so the raw peek below does the one thing the
	// contract needs: preserve the empty map for absent, nil for explicit null.
	state.DLLs = parsed.DLLs
	state.XMLFiles = parsed.XMLFiles
	if !hasKey(raw, "dlls") {
		state.DLLs = map[string]DLLInfo{}
	}
	if !hasKey(raw, "xmlFiles") {
		state.XMLFiles = map[string]XMLFileInfo{}
	}

	return state
}

// hasKey reports whether the top-level object carries the key, without caring about the
// value (null included). A 40-byte buffer is enough for the smallest valid object with
// the key; larger files are checked in full.
func hasKey(raw []byte, key string) bool {
	peek := struct {
		DLLs     json.RawMessage `json:"dlls"`
		XMLFiles json.RawMessage `json:"xmlFiles"`
	}{}
	if err := json.Unmarshal(raw, &peek); err != nil {
		return false
	}
	switch key {
	case "dlls":
		return peek.DLLs != nil
	case "xmlFiles":
		return peek.XMLFiles != nil
	}
	return false
}

// SetupStateSummary mirrors the SUBSET the TS SetupState type exposes to
// bannerlord_index_status: the scalar fields plus the map sizes.
type SetupStateSummary struct {
	GameDir        string
	GameVersion    string
	BuildChangeset string
	FullVersion    string
	VersionSource  string
	DLLScope       string
	XMLScope       string
	DLLCount       int
	XMLFileCount   int
}

// Summarize extracts the scalar subset plus counts, for index-status rendering.
func Summarize(state SetupStateFile) SetupStateSummary {
	return SetupStateSummary{
		GameDir:        state.GameDir,
		GameVersion:    state.GameVersion,
		BuildChangeset: state.BuildChangeset,
		FullVersion:    state.FullVersion,
		VersionSource:  state.VersionSource,
		DLLScope:       state.DLLScope,
		XMLScope:       state.XMLScope,
		DLLCount:       len(state.DLLs),
		XMLFileCount:   len(state.XMLFiles),
	}
}

// TrimmedSetupPath is exported for tests: the state path for a game, resolved the same
// way the loader resolves it.
func TrimmedSetupPath(gameID string) string {
	return env.GetGamePaths(gameID).SetupStatePath
}
