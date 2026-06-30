/**
 * Sniff an image's MIME type from its magic bytes.
 *
 * Avatars arrive with a self-reported type: XEP-0084 metadata advertises a
 * `<info type="...">` and vCard-temp a `<TYPE>`, both set by the *publishing*
 * client. The SDK historically ignored those and hardcoded `image/png` when
 * caching PEP avatars, so animated GIF/WebP/APNG avatars were stored as a Blob
 * typed `image/png`. Browsers content-sniff `<img>` so they still render, but
 * any consumer that trusts `blob.type` (notification file extensions, the GIF
 * freeze-frame extractor) is misled.
 *
 * Rather than trust the advertised type, we sniff the actual bytes — the only
 * authoritative source, and robust against clients that mislabel their avatars.
 *
 * @param base64 - Base64-encoded image data (whitespace tolerated).
 * @returns The detected MIME type, or null when the format isn't recognized so
 *          callers can fall back to a sensible default.
 */
export function sniffImageMimeType(base64: string): string | null {
  if (!base64) return null

  const bytes = decodeBase64(base64)
  if (!bytes || bytes.length < 3) return null

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  // GIF: "GIF8" (covers both GIF87a and GIF89a)
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  ) {
    return 'image/gif'
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A. An animated PNG carries an 'acTL' chunk
  // before the first 'IDAT'; report those as image/apng.
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return hasApngAnimationChunk(bytes) ? 'image/apng' : 'image/png'
  }

  // WebP: "RIFF" <4-byte size> "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'image/webp'
  }

  return null
}

/**
 * Decode base64 to bytes, returning null on malformed input. Avatars are small,
 * so the whole payload is decoded; whitespace (XML-wrapped base64) is stripped.
 */
function decodeBase64(base64: string): Uint8Array | null {
  try {
    const clean = base64.replace(/\s/g, '')
    if (!clean) return null
    const binary = atob(clean)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i)
    }
    return out
  } catch {
    return null
  }
}

/**
 * Walk PNG chunks looking for an 'acTL' animation-control chunk positioned
 * before the first 'IDAT'. Caller guarantees `bytes` starts with the PNG
 * signature.
 */
function hasApngAnimationChunk(bytes: Uint8Array): boolean {
  let offset = 8 // skip the 8-byte PNG signature
  while (offset + 8 <= bytes.length) {
    // Big-endian 4-byte chunk length (avoid << to stay unsigned).
    const length =
      bytes[offset] * 0x1000000 +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    const t0 = bytes[offset + 4]
    const t1 = bytes[offset + 5]
    const t2 = bytes[offset + 6]
    const t3 = bytes[offset + 7]

    // 'acTL'
    if (t0 === 0x61 && t1 === 0x63 && t2 === 0x54 && t3 === 0x4c) return true
    // 'IDAT' — animation control must precede image data, so stop here.
    if (t0 === 0x49 && t1 === 0x44 && t2 === 0x41 && t3 === 0x54) return false

    // Advance past length(4) + type(4) + data(length) + CRC(4).
    offset += 12 + length
  }
  return false
}
