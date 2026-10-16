// XML text decoding for Bannerlord data files.
//
// The game ships a mix of UTF-8 and UTF-16 documents and does not always write
// a BOM, so the encoding is sniffed from the leading bytes before the buffer is
// handed to TextDecoder. A bare `<` alternating with a zero byte is the tell
// for a BOM-less UTF-16 document. Attributes stay enabled: Bannerlord XML
// carries most of its meaning in id/name/value attributes.
import { file } from 'bun'
import { XMLParser } from 'fast-xml-parser'

export const parser = new XMLParser({
  ignoreAttributes: false,
  processEntities: false,
})

export async function readXmlTextFile(fullPath: string): Promise<string> {
  const buffer = await file(fullPath).arrayBuffer()
  return decodeXmlBytes(new Uint8Array(buffer))
}

/**
 * Decodes an XML byte buffer, removing a byte-order mark if the decoder left
 * one in the text.
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  if (bytes.byteLength === 0) {
    return ''
  }

  const text = new TextDecoder(sniffXmlEncoding(bytes)).decode(bytes)
  const startsWithBom = text.length > 0 && text.charCodeAt(0) === 0xfeff
  return startsWithBom ? text.slice(1) : text
}

/** Two-byte signatures first, then the UTF-8 BOM, then BOM-less UTF-16. */
function sniffXmlEncoding(bytes: Uint8Array): string {
  const [b0, b1, b2] = [bytes[0], bytes[1], bytes[2]]

  if (bytes.byteLength >= 2) {
    if (b0 === 0xff && b1 === 0xfe) return 'utf-16le'
    if (b0 === 0xfe && b1 === 0xff) return 'utf-16be'
  }

  if (bytes.byteLength >= 3 && b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    return 'utf-8'
  }

  if (bytes.byteLength >= 4) {
    if (b0 === 0x3c && b1 === 0x00) return 'utf-16le'
    if (b0 === 0x00 && b1 === 0x3c) return 'utf-16be'
  }

  return 'utf-8'
}
