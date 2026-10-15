package parity_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"blore/internal/xmlutil"
)

// ─────────────────────────────────────────────────────────────────────────────
// xml byte-decoding parity (src/utils/xml-utils.ts decodeXmlBytes)
//
// The corpus is RAW BYTE ARRAYS, so nothing here depends on how a file was written to disk. The
// cases that separate a faithful port from a "tidy" one:
//
//   - the bare-`<` sniff is gated on FOUR bytes, so {0x3c, 0x00} decodes as UTF-8 and keeps the
//     NUL, rather than as UTF-16LE
//   - an odd-length UTF-16LE buffer DISCARDS the stray byte: {FF FE FD} is ONE U+FFFD, not two
//   - the decoder is LENIENT: truncated input and unpaired surrogates yield U+FFFD, never an error
//   - a lone BOM becomes the empty string after the leading-U+FEFF strip
// ─────────────────────────────────────────────────────────────────────────────

type xuCase struct {
	Label      string `json:"label"`
	Bytes      []int  `json:"bytes"`
	OK         bool   `json:"ok"`
	Text       string `json:"text"`
	CodePoints []int  `json:"codePoints"`
	Error      string `json:"error"`
}

type xuFixtures struct {
	Cases []xuCase `json:"cases"`
}

func loadXMLUtilFixtures(t *testing.T) xuFixtures {
	t.Helper()
	path := filepath.Join("..", "..", "tools", "parity", "xmlutil_fixtures.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("cannot read fixtures (%s): %v\ngenerate with: bun run server-go/tools/parity/gen_xmlutil_fixtures.mjs", path, err)
	}
	var f xuFixtures
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatalf("fixtures are not valid JSON: %v", err)
	}
	if len(f.Cases) == 0 {
		t.Fatal("fixtures look empty; refusing to report success")
	}
	for _, c := range f.Cases {
		if !c.OK {
			t.Fatalf("fixture %q recorded a THROW (%s); the decoder is documented as lenient", c.Label, c.Error)
		}
	}
	return f
}

// TestXMLDecodeMatchesTypeScript compares the decoded text for every byte array.
//
// It ALSO compares the code points, not just the string. Two different code points can render as
// the same bytes in some terminals, and Go's `string` comparison would already catch that — but a
// failure message that names the code points tells the reader WHICH character moved, which the
// string form does not when the difference is a NUL or a surrogate replacement.
func TestXMLDecodeMatchesTypeScript(t *testing.T) {
	f := loadXMLUtilFixtures(t)

	compared := 0
	for _, c := range f.Cases {
		bytes := make([]byte, len(c.Bytes))
		for i, v := range c.Bytes {
			bytes[i] = byte(v)
		}
		got := xmlutil.DecodeBytes(bytes)

		if got != c.Text {
			t.Errorf("DecodeBytes(%v) [%s]\n  go = %q (codes %v)\n  ts = %q (codes %v)",
				c.Bytes, c.Label,
				got, codePointsOf(got),
				c.Text, c.CodePoints)
			continue
		}
		compared++
	}
	if compared == 0 {
		t.Fatal("no xml decode cases were compared")
	}
	t.Logf("compared %d byte arrays against the TypeScript decoder", compared)
}

// TestXMLDecodeLenientNeverErrors pins the contract that the decoder returns a string for EVERY
// input: malformed bytes must not become an error, because a caller uses this on game files whose
// encoding is exactly what is in doubt.
func TestXMLDecodeLenientNeverErrors(t *testing.T) {
	inputs := [][]byte{
		{},
		{0x00},
		{0xff},
		{0xff, 0xfe},
		{0xfe, 0xff},
		{0xef, 0xbb},
		{0xe4, 0xb8},
		{0x80},
		{0xc0, 0x80},
		{0xff, 0xfe, 0x00, 0xd8, 0x00},
	}
	for _, in := range inputs {
		// Must not panic and must not error: the signature has no error for a decode failure.
		_ = xmlutil.DecodeBytes(in)
	}
}

// TestXMLDecodeSniffThreshold pins the rule that a 2-byte input never triggers the UTF-16 sniff.
//
// This is the case a reader is most likely to "fix": the code says `bytes.length >= 4` while the
// check it guards only reads two bytes. The threshold is deliberate — measured, {0x3c, 0x00}
// yields "<\x00" (UTF-8 with the NUL kept), not "<".
func TestXMLDecodeSniffThreshold(t *testing.T) {
	two := xmlutil.DecodeBytes([]byte{0x3c, 0x00})
	if two != "<\x00" {
		t.Errorf("a 2-byte {3c 00} decoded to %q; the sniff needs 4 bytes so this must stay UTF-8", two)
	}

	four := xmlutil.DecodeBytes([]byte{0x3c, 0x00, 0x61, 0x00})
	if four != "<a" {
		t.Errorf("a 4-byte {3c 00 61 00} decoded to %q; at 4 bytes the sniff fires and it is UTF-16LE", four)
	}

	// Three bytes is still below the gate, so the NUL survives inside the decoded text.
	three := xmlutil.DecodeBytes([]byte{0x3c, 0x00, 0x61})
	if three != "<\x00a" {
		t.Errorf("a 3-byte input decoded to %q; it is below the sniff gate", three)
	}
}

// codePointsOf renders a string as its code points, for a failure message that names the character.
func codePointsOf(s string) []int {
	out := make([]int, 0, len(s))
	for _, r := range s {
		out = append(out, int(r))
	}
	return out
}
