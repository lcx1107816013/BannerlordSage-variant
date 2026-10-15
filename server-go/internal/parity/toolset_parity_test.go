package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"blore/internal/runtimecheck"
	"blore/internal/toolnaming"
	"blore/internal/toolset"
)

// ─────────────────────────────────────────────────────────────────────────────
// bannerlord-toolset parity (src/utils/bannerlord-toolset.ts) and runtime-check
// (src/utils/runtime-check.ts)
//
// The toolset expectations are the real module's own lists and its own mode decisions, read through
// the real process.env. The runtime-check expectations come from the real file predicates against a
// tree on disk whose directories are crafted for the branch shapes:
//
//   - a directory with files at the top level AND three levels down (both probes walk)
//   - an EMPTY directory (exists, holds nothing)
//   - a directory whose ONLY file is nested (so a single-level read would say false)
//   - a FILE used as the directory argument, which the TypeScript THROWS on and the first version of
//     this port silently answered 0 for
// ─────────────────────────────────────────────────────────────────────────────

type tsModeCase struct {
	Input     *string `json:"input"`
	Mode      string  `json:"mode"`
	ToolCount int     `json:"toolCount"`
}

type tsProbeCase struct {
	Label         string  `json:"label"`
	Dir           string  `json:"dir"`
	Exists        *bool   `json:"exists"`
	ExistsThrew   *string `json:"existsThrew"`
	HasFiles      *bool   `json:"hasFiles"`
	HasFilesThrew *string `json:"hasFilesThrew"`
	Count         *int    `json:"count"`
	CountThrew    *string `json:"countThrew"`
}

type tsFixtures struct {
	TreeRoot        string        `json:"treeRoot"`
	Shape           treeShape     `json:"shape"`
	ModeCases       []tsModeCase  `json:"modeCases"`
	QueryFirstTools []string      `json:"queryFirstTools"`
	AuthoringTools  []string      `json:"authoringTools"`
	ProbeCases      []tsProbeCase `json:"probeCases"`
}

func loadToolsetFixtures(t *testing.T) tsFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "toolset_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_toolset_fixtures.mjs", path, err)
	}
	var f tsFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.ModeCases) == 0 || len(f.QueryFirstTools) == 0 || len(f.ProbeCases) == 0 {
		t.Fatal("fixtures look incomplete; refusing to report success")
	}
	return f
}

// ─────────────────────────────────────────────────────────────────────────────
// The two fixture TREES are rebuilt here from the `shape` the generator emitted.
//
// ★ WHY THEY ARE NOT COMMITTED. One case in each tree is an EMPTY directory — "exists but holds no
// files" — and git does not track empty directories. Committing the tree would have needed a
// placeholder file inside it, and that file would have destroyed the very case it was meant to
// preserve: the directory would no longer be empty, so `hasFiles` would flip to true and the case
// would silently stop testing anything. The shape therefore lives in the fixture JSON (written by
// the same generator that recorded the expectations) and BOTH sides build from it, so there is one
// description of the tree rather than two.
// ─────────────────────────────────────────────────────────────────────────────

type treeShape struct {
	Dirs  []string          `json:"dirs"`
	Files map[string]string `json:"files"`
}

// buildTree creates the fixture tree under the repo's fixtures directory, replacing any previous
// copy so a run is idempotent.
//
// It refuses to touch a path outside tools/parity/fixtures: the tree is a fixture, and the guard
// exists because ledger F19 records a generator that wrote to a real data path it had derived.
func buildTree(t *testing.T, root string, shape treeShape) {
	t.Helper()
	if len(shape.Dirs) == 0 && len(shape.Files) == 0 {
		t.Fatalf("fixture shape for %s is empty; refusing to build nothing", root)
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(filepath.ToSlash(abs), "/tools/parity/fixtures/") {
		t.Fatalf("refusing to build a fixture tree outside tools/parity/fixtures: %s", abs)
	}
	if err := os.RemoveAll(abs); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	for _, dir := range shape.Dirs {
		if err := os.MkdirAll(filepath.Join(abs, filepath.FromSlash(dir)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for file, content := range shape.Files {
		full := filepath.Join(abs, filepath.FromSlash(file))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestToolsetModeMatchesTypeScript(t *testing.T) {
	f := loadToolsetFixtures(t)
	for _, c := range f.ModeCases {
		input := deref(c.Input)
		lookup := func(key string) (string, bool) {
			if key != "BANNERSAGE_TOOLSET" {
				return "", false
			}
			if c.Input == nil {
				return "", false
			}
			return input, true
		}
		// ★ THE INPUT IS PRESENT ONLY WHEN THE FIXTURE'S IS: an absent variable and an empty one are
		// different states for the lookup, and the TypeScript distinguishes them the same way.
		if got := toolset.GetMode(lookup); got != c.Mode {
			t.Errorf("GetMode(input=%q present=%v) = %q, want %q", input, c.Input != nil, got, c.Mode)
		}
		if got := len(toolset.GetActiveToolNames(lookup)); got != c.ToolCount {
			t.Errorf("GetActiveToolNames(input=%q) has %d names, want %d", input, got, c.ToolCount)
		}
	}
	t.Logf("compared %d toolset mode cases", len(f.ModeCases))
}

func TestToolsetNameListsMatchTypeScript(t *testing.T) {
	f := loadToolsetFixtures(t)

	compare := func(label string, got, want []string) {
		t.Helper()
		if len(got) != len(want) {
			t.Fatalf("%s has %d entries, want %d\ngot:  %v\nwant: %v", label, len(got), len(want), got, want)
		}
		for i := range got {
			if got[i] != want[i] {
				t.Errorf("%s[%d] = %q, want %q (order matters: callers iterate this to register)", label, i, got[i], want[i])
			}
		}
	}

	compare("QueryFirstToolNames", toolset.QueryFirstToolNames, f.QueryFirstTools)
	compare("AuthoringToolNames", toolset.AuthoringToolNames, f.AuthoringTools)

	// The names must be the LEGACY names run through the shared helper — that is the mechanism the
	// module's comment says exists to stop a drifted second copy of the naming rule.
	for i, want := range f.QueryFirstTools {
		if !strings.HasPrefix(want, toolnaming.ArchivePrefix) {
			t.Errorf("fixture name %q does not carry the archive prefix; the fixture itself is wrong", want)
			continue
		}
		_ = i
	}
}

// TestRuntimeCheckProbesMatchTypeScript compares the two probes themselves, against expectations
// produced by the real module with env.ts and game-profiles.ts injected.
//
// ★ WHAT THE CORPUS IS FOR. The probes have almost no logic of their own — the composition
// `!requires || probe` is the whole of it — so a corpus of "ready/not ready" values would pass for
// a dozen implementations. What it actually separates is the DECISION each probe makes about
// reading: the readiness probe SKIPS a directory the profile does not require, while the status
// probe COUNTS it anyway. The tree is built so those two rules produce different numbers, and the
// empty-xml case makes the skip visible as a false.
func TestRuntimeCheckProbesMatchTypeScript(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tools", "parity", "runtimecheck_fixtures.json"))
	if err != nil {
		t.Fatalf("cannot read fixtures: %v\ngenerate with: bun run server-go/tools/parity/gen_runtimecheck_fixtures.mjs", err)
	}
	var f struct {
		Shape       treeShape `json:"shape"`
		SourcePath  string    `json:"sourcePath"`
		XMLsPath    string    `json:"xmlsPath"`
		DBPath      string    `json:"dbPath"`
		MissingPath string    `json:"missingPath"`
		Readiness   []struct {
			Label    string          `json:"label"`
			Requires json.RawMessage `json:"requires"`
			Result   struct {
				GameID   string `json:"gameId"`
				Ready    bool   `json:"ready"`
				DBExists bool   `json:"dbExists"`
			} `json:"result"`
		} `json:"readinessCases"`
		Status []struct {
			Label    string          `json:"label"`
			Requires json.RawMessage `json:"requires"`
			Result   struct {
				GameID      string `json:"gameId"`
				Ready       bool   `json:"ready"`
				SourceFiles int    `json:"sourceFiles"`
				XMLFiles    int    `json:"xmlFiles"`
				DBExists    bool   `json:"dbExists"`
			} `json:"result"`
		} `json:"statusCases"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Readiness) == 0 || len(f.Status) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}

	base := filepath.Join("..", "..", "tools", "parity", "fixtures", "runtimecheck-probe-tree")
	buildTree(t, base, f.Shape)
	source := filepath.Join(base, "source")
	xmls := filepath.Join(base, "xmls")
	db := filepath.Join(base, "index.db")
	missing := filepath.Join(base, "absent")

	decodeRequires := func(raw json.RawMessage) runtimecheck.Requires {
		var r struct {
			RequiresSource bool `json:"requiresSource"`
			RequiresXML    bool `json:"requiresXml"`
			RequiresDB     bool `json:"requiresDb"`
		}
		if err := json.Unmarshal(raw, &r); err != nil {
			t.Fatalf("case requires undecodable: %v", err)
		}
		return runtimecheck.Requires{Source: r.RequiresSource, XML: r.RequiresXML, DB: r.RequiresDB}
	}

	for _, c := range f.Readiness {
		requires := decodeRequires(c.Requires)
		got, err := runtimecheck.GetReadiness("bannerlord", requires, source, xmls, db)
		if err != nil {
			t.Errorf("%s: GetReadiness errored: %v", c.Label, err)
			continue
		}
		if got.Ready != c.Result.Ready || got.DBExists != c.Result.DBExists || got.GameID != c.Result.GameID {
			t.Errorf("%s: GetReadiness = %+v, want ready=%v dbExists=%v gameId=%q",
				c.Label, got, c.Result.Ready, c.Result.DBExists, c.Result.GameID)
		}
	}

	for _, c := range f.Status {
		requires := decodeRequires(c.Requires)
		got, err := runtimecheck.GetStatus("bannerlord", requires, source, xmls, db)
		if err != nil {
			t.Errorf("%s: GetStatus errored: %v", c.Label, err)
			continue
		}
		if got.Ready != c.Result.Ready || got.SourceFiles != c.Result.SourceFiles ||
			got.XMLFiles != c.Result.XMLFiles || got.DBExists != c.Result.DBExists {
			t.Errorf("%s: GetStatus = %+v, want ready=%v source=%d xml=%d db=%v",
				c.Label, got, c.Result.Ready, c.Result.SourceFiles, c.Result.XMLFiles, c.Result.DBExists)
		}
	}

	// ★ THE MISSING-DB SIDE IS ASSERTED FROM THE PORT'S OWN ARGUMENTS, not against a fixture: the
	// TypeScript reads its db path from a module constant, so reaching a second path in one process
	// required a separate module instance. The GO side takes the path as an argument, which the
	// generator recorded rather than simulated. The rule is checked directly.
	absent, err := runtimecheck.GetReadiness("bannerlord", runtimecheck.Requires{DB: true}, source, xmls, missing)
	if err != nil {
		t.Fatal(err)
	}
	if absent.Ready || absent.DBExists {
		t.Errorf("with a required-and-absent database the probe must report not-ready; got %+v", absent)
	}
	notRequired, err := runtimecheck.GetReadiness("bannerlord", runtimecheck.Requires{}, source, xmls, missing)
	if err != nil {
		t.Fatal(err)
	}
	if !notRequired.Ready {
		t.Errorf("with nothing required the probe must report ready even when the db is absent; got %+v", notRequired)
	}
}

// TestToolsetActiveNamesAreCopies pins that a caller cannot mutate the package-level lists through
// the returned slice. The TypeScript returns fresh arrays via spread, so a mutation there cannot
// either.
//
// ★ BOTH BRANCHES ARE COVERED. The first version of this test only exercised the FULL branch, and a
// mutant that returned the live QueryFirstToolNames slice from the query-first branch therefore
// survived — a real coverage gap, found by the mutation run rather than by a failing assertion.
func TestToolsetActiveNamesAreCopies(t *testing.T) {
	full := toolset.GetActiveToolNames(func(string) (string, bool) { return "", false })
	if len(full) == 0 {
		t.Fatal("expected a non-empty tool list")
	}
	full[0] = "MUTATED"
	if toolset.QueryFirstToolNames[0] == "MUTATED" {
		t.Error("GetActiveToolNames (full) returned the package slice itself; a caller can corrupt the list")
	}

	// The query-first branch returns only the first tier, and it is a SEPARATE code path.
	queryFirst := toolset.GetActiveToolNames(func(string) (string, bool) { return "query-first", true })
	if len(queryFirst) == 0 {
		t.Fatal("expected a non-empty query-first tool list")
	}
	if len(queryFirst) != len(toolset.QueryFirstToolNames) {
		t.Fatalf("query-first returned %d names, want %d", len(queryFirst), len(toolset.QueryFirstToolNames))
	}
	queryFirst[0] = "MUTATED"
	if toolset.QueryFirstToolNames[0] == "MUTATED" {
		t.Error("GetActiveToolNames (query-first) returned the package slice itself; a caller can corrupt the list")
	}
}

func TestRuntimeCheckPredicatesMatchTypeScript(t *testing.T) {
	f := loadToolsetFixtures(t)

	// The fixture's tree lives under tools/parity/fixtures; the paths recorded in the JSON are
	// absolute for this machine, so only the LAST segments are used and the root is rebuilt here.
	root := filepath.Join("..", "..", "tools", "parity", "fixtures", "runtimecheck-tree")
	buildTree(t, root, f.Shape)

	relOf := func(abs string) string {
		// The absolute path's tail after the tree root is what identifies the case.
		marker := "runtimecheck-tree"
		if idx := strings.Index(abs, marker); idx >= 0 {
			tail := abs[idx+len(marker):]
			tail = strings.TrimPrefix(tail, string(os.PathSeparator))
			tail = strings.TrimPrefix(tail, "/")
			if tail == "" {
				return root
			}
			return filepath.Join(root, filepath.FromSlash(strings.ReplaceAll(tail, "\\", "/")))
		}
		return root
	}

	compared := 0
	for _, c := range f.ProbeCases {
		dir := relOf(c.Dir)

		exists, err := runtimecheck.FileExists(dir)
		checkBoolProbe(t, c.Label, "FileExists", c.Exists, c.ExistsThrew, exists, err)

		hasFiles, err := runtimecheck.DirectoryHasFiles(dir)
		checkBoolProbe(t, c.Label, "DirectoryHasFiles", c.HasFiles, c.HasFilesThrew, hasFiles, err)

		count, err := runtimecheck.CountFilesInDirectory(dir)
		checkIntProbe(t, c.Label, "CountFilesInDirectory", c.Count, c.CountThrew, count, err)

		compared++
	}
	t.Logf("compared %d predicate cases", compared)
}

// The three probes are checked by three small helpers rather than one generic: each compares a
// different value type, and a type parameter would buy nothing but an unformattable error message.

func checkBoolProbe(t *testing.T, label, name string, wantVal *bool, wantThrew *string, got bool, err error) {
	t.Helper()
	if wantThrew != nil {
		if err == nil {
			t.Errorf("%s: %s = %v, but the TypeScript THREW (%s)", label, name, got, *wantThrew)
			return
		}
		checkErrCode(t, label, name, *wantThrew, err)
		return
	}
	if wantVal == nil {
		t.Errorf("%s: the fixture recorded neither a value nor a throw for %s", label, name)
		return
	}
	if err != nil {
		t.Errorf("%s: %s errored (%v), but the TypeScript returned a value", label, name, err)
		return
	}
	if got != *wantVal {
		t.Errorf("%s: %s = %v, want %v", label, name, got, *wantVal)
	}
}

func checkIntProbe(t *testing.T, label, name string, wantVal *int, wantThrew *string, got int, err error) {
	t.Helper()
	if wantThrew != nil {
		if err == nil {
			t.Errorf("%s: %s = %v, but the TypeScript THREW (%s)", label, name, got, *wantThrew)
			return
		}
		checkErrCode(t, label, name, *wantThrew, err)
		return
	}
	if wantVal == nil {
		t.Errorf("%s: the fixture recorded neither a value nor a throw for %s", label, name)
		return
	}
	if err != nil {
		t.Errorf("%s: %s errored (%v), but the TypeScript returned a value", label, name, err)
		return
	}
	if got != *wantVal {
		t.Errorf("%s: %s = %v, want %v", label, name, got, *wantVal)
	}
}

// checkErrCode compares a Go error against the POSIX code the TypeScript's exception carried.
//
// ★ THE TWO DO NOT SHARE A STRING. Node reports `code: 'ENOTDIR'` while Go's PathError says
// "not a directory"; neither contains the other, so a substring comparison fails on a result that
// is in fact correct — which is what the first version of this helper did. The mapping is explicit
// so an unmapped code is a visible failure rather than a silent pass.
func checkErrCode(t *testing.T, label, name, wantCode string, err error) {
	t.Helper()
	english, ok := map[string]string{
		"ENOTDIR": "not a directory",
		"ENOENT":  "no such file or directory",
		"EACCES":  "permission denied",
		"EPERM":   "operation not permitted",
	}[wantCode]
	if !ok {
		t.Errorf("%s: this test has no mapping for the TypeScript code %s; add one rather than "+
			"assuming the port is wrong", label, wantCode)
		return
	}
	if !strings.Contains(strings.ToLower(err.Error()), english) {
		t.Errorf("%s: %s errored with %q; the TypeScript's %s means %q", label, name, err, wantCode, english)
	}
}
