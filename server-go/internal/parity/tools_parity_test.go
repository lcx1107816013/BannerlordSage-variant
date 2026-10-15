package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"blore/internal/sandbox"
	"blore/internal/tools"
)

// ─────────────────────────────────────────────────────────────────────────────
// Tool-body parity (src/tools/read-file.ts, src/tools/list-directory.ts)
//
// The first TOOL-layer units, so the fixtures capture the rendered report TEXT rather than
// a return value. That is the stronger assertion: downstream consumers parse this text,
// so a byte difference is a real difference.
//
// The corpus pins the details a careful reader would "correct" in the port:
//   - `resolved_path` holds the RELATIVE path despite the key name
//   - `start_line_0based` / `requested_line_count` are the RAW request values, so a
//     negative startLine appears as negative
//   - `returned_line_count` uses the RAW startLine, so it can disagree with the number of
//     lines actually in file_content
//   - an empty directory renders the literal sentence "Directory is empty."
//   - the sort is by UTF-16 CODE UNIT, which inverts relative to byte order above the BMP
// ─────────────────────────────────────────────────────────────────────────────

type toolsReadFileProbe struct {
	Path      string `json:"path"`
	StartLine int    `json:"startLine"`
	LineCount int    `json:"lineCount"`
	OK        bool   `json:"ok"`
	Text      string `json:"text"`
	Error     string `json:"error"`
}

type toolsListDirProbe struct {
	Path  string `json:"path"`
	OK    bool   `json:"ok"`
	Text  string `json:"text"`
	Error string `json:"error"`
}

type toolsFixtures struct {
	SandboxRoot           string               `json:"sandboxRoot"`
	ReadFile              []toolsReadFileProbe `json:"readFile"`
	ReadFileFailures      []toolsReadFileProbe `json:"readFileFailures"`
	ListDirectory         []toolsListDirProbe  `json:"listDirectory"`
	ListDirectoryFailures []toolsListDirProbe  `json:"listDirectoryFailures"`
}

func loadToolsFixtures(t *testing.T) (toolsFixtures, *sandbox.Sandbox) {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "tools_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_tools_fixtures.mjs", path, err)
	}
	var f toolsFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.ReadFile) == 0 || len(f.ListDirectory) == 0 {
		t.Fatalf("fixtures look empty (readFile=%d listDirectory=%d); refusing to report success",
			len(f.ReadFile), len(f.ListDirectory))
	}
	// Every failure probe must have recorded a rejection. If one ever resolves, the
	// fixture is describing behaviour this test does not assert, and the guarantee would
	// silently thin out.
	for _, p := range f.ReadFileFailures {
		if p.OK {
			t.Fatalf("fixture says readFile(%q) RESOLVED; this test asserts it must reject", p.Path)
		}
	}
	for _, p := range f.ListDirectoryFailures {
		if p.OK {
			t.Fatalf("fixture says listDirectory(%q) RESOLVED; this test asserts it must reject", p.Path)
		}
	}

	root := filepath.Join("..", "..", "tools", "parity", f.SandboxRoot)
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("sandbox corpus missing (%s): %v\nregenerate the fixtures", root, err)
	}
	return f, sandbox.New("", root)
}

func TestReadFileMatchesTypeScript(t *testing.T) {
	f, box := loadToolsFixtures(t)

	compared := 0
	for _, p := range f.ReadFile {
		if !p.OK {
			continue // recorded rejections are asserted separately
		}
		got, err := tools.ReadFile(box, p.Path, p.StartLine, p.LineCount)
		if err != nil {
			t.Errorf("ReadFile(%q, %d, %d) errored: %v", p.Path, p.StartLine, p.LineCount, err)
			continue
		}
		if got != p.Text {
			t.Errorf("ReadFile(%q, %d, %d) differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				p.Path, p.StartLine, p.LineCount, got, p.Text, textFirstDiff(got, p.Text))
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no readFile probes were compared")
	}
	t.Logf("compared %d readFile reports against the TypeScript output", compared)
}

// The failure modes must REJECT. A silent empty report would turn "no such file" or
// "outside the sandbox" into a confident empty answer, which is the failure class this
// project keeps finding.
func TestReadFileRejections(t *testing.T) {
	f, box := loadToolsFixtures(t)

	// The traversal and absolute-path probes must be refused by the SANDBOX, and the exact
	// message is asserted so a regression in the sandbox shows up here too.
	for _, p := range f.ReadFileFailures {
		_, err := tools.ReadFile(box, p.Path, p.StartLine, p.LineCount)
		if err == nil {
			t.Errorf("ReadFile(%q) returned no error; the TypeScript rejected it", p.Path)
			continue
		}
		if err.Error() != p.Error {
			t.Errorf("ReadFile(%q) error text\n  go = %q\n  ts = %q", p.Path, err.Error(), p.Error)
		}
	}
	t.Logf("asserted %d readFile rejection messages against the TypeScript", len(f.ReadFileFailures))
}

func TestListDirectoryMatchesTypeScript(t *testing.T) {
	f, box := loadToolsFixtures(t)

	compared := 0
	for _, p := range f.ListDirectory {
		if !p.OK {
			continue
		}
		got, err := tools.ListDirectory(box, p.Path)
		if err != nil {
			t.Errorf("ListDirectory(%q) errored: %v", p.Path, err)
			continue
		}
		if got != p.Text {
			t.Errorf("ListDirectory(%q) differs\n--- go ---\n%s\n--- ts ---\n%s\n--- %s ---",
				p.Path, got, p.Text, textFirstDiff(got, p.Text))
		}
		compared++
	}
	t.Logf("compared %d directory listings against the TypeScript output", compared)

	// ★ The sort rule is asserted directly, not only through the listing text. Go's
	// sort.Strings orders by UTF-8 bytes; JavaScript orders by UTF-16 code units, and the
	// two disagree above the BMP. This pair is the discriminating case: the emoji is a
	// supplementary character whose UTF-16 leading unit (D83C) is BELOW U+E000, while its
	// UTF-8 bytes are ABOVE. A port using sort.Strings would produce the reverse order.
	var listingProbe *toolsListDirProbe
	for i := range f.ListDirectory {
		if f.ListDirectory[i].Path == "listing" {
			listingProbe = &f.ListDirectory[i]
			break
		}
	}
	if listingProbe == nil {
		t.Fatal("the corpus no longer contains the 'listing' probe; the sort rule is untested")
	}
	emojiAt := indexOfLine(listingProbe.Text, "\U0001F3AF-emoji.txt")
	bmpAt := indexOfLine(listingProbe.Text, "\uE000-bmp.txt")
	if emojiAt < 0 || bmpAt < 0 {
		t.Fatalf("the listing corpus lost its supplementary/BMP pair (emoji=%d bmp=%d); "+
			"without both, byte order and UTF-16 order cannot be told apart", emojiAt, bmpAt)
	}
	if emojiAt > bmpAt {
		t.Errorf("fixture ordering is not UTF-16: emoji at line %d, BMP at line %d", emojiAt, bmpAt)
	}
	got, err := tools.ListDirectory(box, "listing")
	if err != nil {
		t.Fatalf("ListDirectory(listing) errored: %v", err)
	}
	if indexOfLine(got, "\U0001F3AF-emoji.txt") > indexOfLine(got, "\uE000-bmp.txt") {
		t.Errorf("the port ordered the listing by bytes, not UTF-16 code units:\n%s", got)
	}
}

func TestListDirectoryRejections(t *testing.T) {
	f, box := loadToolsFixtures(t)
	for _, p := range f.ListDirectoryFailures {
		_, err := tools.ListDirectory(box, p.Path)
		if err == nil {
			t.Errorf("ListDirectory(%q) returned no error; the TypeScript rejected it", p.Path)
			continue
		}
		if err.Error() != p.Error {
			t.Errorf("ListDirectory(%q) error text\n  go = %q\n  ts = %q", p.Path, err.Error(), p.Error)
		}
	}
	t.Logf("asserted %d listDirectory rejection messages against the TypeScript", len(f.ListDirectoryFailures))
}

// indexOfLine returns the 0-based line index of want, or -1.
func indexOfLine(haystack, want string) int {
	lines := splitOnLF(haystack)
	for i, l := range lines {
		if l == want {
			return i
		}
	}
	return -1
}

// splitOnLF splits a report on newlines.
//
// ★ It uses strings.Split, NOT a byte loop. A previous version accumulated
// `cur += string(s[i])`, and `string(byte)` converts the byte VALUE to a codepoint:
// byte 0xF0 became U+00F0 instead of contributing to a UTF-8 sequence. Every multi-byte
// character was therefore mangled, so a lookup for a name containing an emoji or a CJK
// character failed even though the line was present — the test reported "corpus lost its
// supplementary/BMP pair" while the corpus was intact. Byte-indexing a string is only
// safe when the code is deliberately ASCII-only.
func splitOnLF(s string) []string {
	return strings.Split(s, "\n")
}

// textFirstDiff names the first differing line, which is far more useful than two full
// dumps when only one field differs.
//
// ★ The escaping in the message is display-ONLY: strconv.Quote so a control character in
// a report is readable. An earlier version of this helper was also used to look up a line,
// which was wrong — Quote turns a U+E000 filename into the literal text `\ue000-bmp.txt`,
// so the lookup failed while the line was right there. Lookups compare raw strings;
// formatting is only for the failure message.
func textFirstDiff(a, b string) string {
	al := splitOnLF(a)
	bl := splitOnLF(b)
	for i := 0; i < len(al) && i < len(bl); i++ {
		if al[i] != bl[i] {
			return "first difference at line " + strconv.Itoa(i+1) +
				": go=" + strconv.Quote(al[i]) + " ts=" + strconv.Quote(bl[i])
		}
	}
	if len(al) != len(bl) {
		return "line counts differ: go=" + strconv.Itoa(len(al)) + " ts=" + strconv.Itoa(len(bl))
	}
	return "no line difference (trailing bytes only)"
}
