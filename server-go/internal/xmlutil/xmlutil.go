// Package xmlutil ports the byte-decoding half of src/utils/xml-utils.ts.
//
// Bannerlord ships XML in both UTF-8 and UTF-16, sometimes WITHOUT a BOM, so the decoder sniffs
// the header bytes before handing the buffer to a decoder. Only that half is ported:
// the module's other export is `parser = new XMLParser({...})`, which is the third-party
// fast-xml-parser package. It is deliberately absent here — porting a dependency is not a port,
// and nothing in the decoded text depends on it.
package xmlutil

import (
	"os"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// ReadTextFile mirrors readXmlTextFile.
func ReadTextFile(fullPath string) (string, error) {
	bytes, err := os.ReadFile(fullPath)
	if err != nil {
		return "", err
	}
	return DecodeBytes(bytes), nil
}

// DecodeBytes mirrors decodeXmlBytes.
//
// ★ EVERY RULE BELOW WAS MEASURED against the real function under bun 1.4.3, not read off the
// spec — and the first version of this file was WRONG in three places because those rules had been
// guessed. The differential suite caught all three. The measured table, which this implementation
// reproduces:
//
//	[]                       -> ""              (the empty case short-circuits)
//	[0x3c,0x61,0x3e]         -> "<a>"           (plain UTF-8)
//	[EF BB BF, 3c,61,3e]     -> "<a>"           (UTF-8 BOM, stripped after decoding)
//	[FF FE, 3c,00,61,00,3e,00] -> "<a>"         (UTF-16LE BOM)
//	[FE FF, 00,3c,00,61,00,3e] -> "<a>"         (UTF-16BE BOM)
//	[3c,00,61,00,3e,00]      -> "<a>"           (BOM-less LE, from the bare `<`)
//	[00,3c,00,61,00,3e]      -> "<a>"           (BOM-less BE)
//	[0x3c, 0x00]             -> "<\x00"         ★ the sniff needs FOUR bytes; at length 2 the
//	                                            bare-`<` rule cannot fire, so this decodes as
//	                                            UTF-8 and the NUL survives as a character
//	[0x00, 0x3c]             -> "\x00<"         ★ same shape, other order
//	[EF BB BF]               -> ""              (a lone BOM becomes empty after the strip)
//	[FF FE, 3c, 00, 61]      -> "<\uFFFD"       ★ an odd byte count does NOT drop the stray byte:
//	                                            it becomes ONE U+FFFD after the decoded text
//	[FF FE, FD]              -> "\uFFFD"        ★ the BOM plus one stray byte yields exactly one
//	                                            replacement character, NOT the empty string
//	[FF FE, 00,D8]           -> "\uFFFD"        (an unpaired surrogate becomes U+FFFD)
//	[E4 B8 AD]               -> "中"
//	[E4 B8]                  -> "\uFFFD"        ★ a TRUNCATED UTF-8 SEQUENCE is ONE replacement
//	                                            character, not one per byte
//
// ★ THE DECODER IS LENIENT, NOT STRICT, AND ITS REPLACEMENT GRANULARITY DIFFERS BY ENCODING.
// Truncated input and invalid bytes produce U+FFFD rather than an error — but:
//   - UTF-16: the stray trailing byte yields one U+FFFD (so {FF FE FD} is "\uFFFD", not "")
//   - UTF-8:  an INCOMPLETE MULTI-BYTE SEQUENCE yields ONE U+FFFD (so {E4 B8} is one character,
//     while a per-byte loop would emit two)
//
// The UTF-8 half is why this uses `utf8.DecodeRune`'s size rather than walking byte by byte: a
// decoded RuneError with size 1 is a single bad byte, and a sequence that fails part-way must
// consume the bytes it examined.
func DecodeBytes(bytes []byte) string {
	if len(bytes) == 0 {
		return ""
	}

	encoding := detectEncoding(bytes)
	var text string
	switch encoding {
	case "utf-16le":
		text = decodeUTF16(bytes, true)
	case "utf-16be":
		text = decodeUTF16(bytes, false)
	default:
		text = decodeUTF8Lenient(bytes)
	}

	// Drop a leading BOM character if the decoder kept it.
	return strings.TrimPrefix(text, "\uFEFF")
}

// detectEncoding mirrors detectXmlEncoding.
//
// ★ THE ORDER OF THE CHECKS MATTERS, AND SO DOES THE LENGTH GATE. The BOM checks come first; the
// bare-`<` pair is checked only at length >= 4, which is why a 2-byte input like {0x3c, 0x00} does
// NOT decode as UTF-16LE. A "tidier" version that tested the first two bytes without the length
// gate would agree with the original on every file and disagree on exactly that input.
func detectEncoding(bytes []byte) string {
	if len(bytes) >= 2 {
		if bytes[0] == 0xFF && bytes[1] == 0xFE {
			return "utf-16le"
		}
		if bytes[0] == 0xFE && bytes[1] == 0xFF {
			return "utf-16be"
		}
	}

	if len(bytes) >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
		return "utf-8"
	}

	if len(bytes) >= 4 {
		if bytes[0] == 0x3C && bytes[1] == 0x00 {
			return "utf-16le"
		}
		if bytes[0] == 0x00 && bytes[1] == 0x3C {
			return "utf-16be"
		}
	}

	return "utf-8"
}

// decodeUTF16 mirrors TextDecoder('utf-16le'|'utf-16be').decode() under the default settings.
//
// ★ AN ODD TRAILING BYTE BECOMES ONE U+FFFD — IT IS NOT DISCARDED. Measured: {FF FE, 3c, 00, 61}
// decodes to "<\uFFFD" and {FF FE, FD} decodes to "\uFFFD", not to "". Go's utf16.Decode does NOT
// do this on its own: it consumes exactly the pairs it is given and silently ignores a remainder,
// which is why the stray byte is appended here as its own unit — a lone high byte forms no
// surrogate pair, so the standard decoder turns it into the replacement character. The first
// version of this function dropped the byte and disagreed with the TypeScript on two cases.
//
// ★ AN UNPAIRED SURROGATE BECOMES ONE U+FFFD. Go's utf16.Decode already does that, which is why it
// is used rather than a hand-rolled loop.
func decodeUTF16(bytes []byte, littleEndian bool) string {
	units := make([]uint16, 0, len(bytes)/2+1)
	pairs := len(bytes) / 2
	for i := 0; i < pairs; i++ {
		lo, hi := bytes[i*2], bytes[i*2+1]
		if littleEndian {
			units = append(units, uint16(lo)|uint16(hi)<<8)
		} else {
			units = append(units, uint16(lo)<<8|uint16(hi))
		}
	}
	// A trailing odd byte is ALWAYS U+FFFD — it is not decoded by value. Measured: {FF FE, 3c, 00, 61}
	// is "<\uFFFD" (not "<a") and {FF FE, FD} is "\uFFFD" (not "ý"), so the byte's numeric value
	// never reaches the output. Appending the replacement unit is what mirrors that.
	if len(bytes)%2 != 0 {
		units = append(units, 0xFFFD)
	}
	return string(utf16.Decode(units))
}

// decodeUTF8Lenient mirrors TextDecoder('utf-8').decode(): invalid sequences become U+FFFD and no
// error is raised.
//
// ★ IT REPLACES ONCE PER FAILED SEQUENCE, NOT ONCE PER BYTE. Measured, {E4 B8} is ONE U+FFFD while
// a byte-at-a-time walk emits two. This is the WHATWG "maximal subpart" rule, and Go's standard
// library does NOT implement it: utf8.DecodeRune reports a truncated sequence as RuneError with
// size 1, exactly like a genuinely invalid byte, so the two cases cannot be told apart from its
// return values alone. The length is therefore determined here the way the spec determines it —
// from the lead byte and how many continuation bytes actually follow.
//
// The rule, applied in order:
//
//	lead 0xC2-0xDF needs 1 continuation; 0xE0-0xEF needs 2; 0xF0-0xF4 needs 3
//	a lead outside those ranges (and every byte 0x80-0xBF) consumes ONE byte
//	a lead that is valid but short of continuations consumes the lead AND the continuations that
//	  ARE present — one replacement character for the whole prefix
//
// ★ THE DISTINCTION THAT MATTERS: {0xFF} is one replacement either way, but {0xE4, 0xB8} is ONE
// replacement covering two bytes, and {0xE4, 0xB8, 0xAD} is the character 中. An implementation
// that emitted one replacement per byte would look right on the first and third and be wrong on
// the second, which is exactly the case the fixture set contains.
func decodeUTF8Lenient(bytes []byte) string {
	var b strings.Builder
	b.Grow(len(bytes))
	for len(bytes) > 0 {
		lead := bytes[0]
		switch {
		case lead < 0x80:
			b.WriteByte(lead)
			bytes = bytes[1:]
		case lead >= 0xC2 && lead <= 0xDF:
			if n, ok := countContinuations(bytes, 1); ok {
				b.WriteString(string(bytes[:1+n]))
				bytes = bytes[1+n:]
			} else {
				b.WriteRune(utf8.RuneError)
				bytes = bytes[1+n:]
			}
		case lead >= 0xE0 && lead <= 0xEF:
			if n, ok := countContinuations(bytes, 2); ok {
				b.WriteString(string(bytes[:1+n]))
				bytes = bytes[1+n:]
			} else {
				b.WriteRune(utf8.RuneError)
				bytes = bytes[1+n:]
			}
		case lead >= 0xF0 && lead <= 0xF4:
			if n, ok := countContinuations(bytes, 3); ok {
				b.WriteString(string(bytes[:1+n]))
				bytes = bytes[1+n:]
			} else {
				b.WriteRune(utf8.RuneError)
				bytes = bytes[1+n:]
			}
		default:
			// A bare continuation byte, or a lead that cannot start any sequence: one byte, one
			// replacement character.
			b.WriteRune(utf8.RuneError)
			bytes = bytes[1:]
		}
	}
	return b.String()
}

// countContinuations reports how many continuation bytes follow the lead in bytes[1:], capped at
// want. ok is false when fewer than want are present, in which case n is however many were there —
// because a truncated sequence consumes its lead and its partial continuations as ONE failure.
func countContinuations(bytes []byte, want int) (n int, ok bool) {
	for n < want {
		if 1+n >= len(bytes) {
			return n, false
		}
		next := bytes[1+n]
		if next < 0x80 || next > 0xBF {
			return n, false
		}
		n++
	}
	return n, true
}
