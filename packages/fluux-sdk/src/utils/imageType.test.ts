import { describe, it, expect } from 'vitest'
import { sniffImageMimeType } from './imageType'

/** Base64-encode a byte array (small fixtures only). */
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

/** Build a PNG chunk: 4-byte big-endian length, 4-byte ASCII type, data, 4-byte CRC. */
function pngChunk(type: string, dataLen = 0): number[] {
  const typeBytes = [...type].map((c) => c.charCodeAt(0))
  const len = [
    (dataLen >>> 24) & 0xff,
    (dataLen >>> 16) & 0xff,
    (dataLen >>> 8) & 0xff,
    dataLen & 0xff,
  ]
  const data = new Array(dataLen).fill(0)
  const crc = [0, 0, 0, 0]
  return [...len, ...typeBytes, ...data, ...crc]
}

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('sniffImageMimeType', () => {
  it('detects a still PNG from its 8-byte signature', () => {
    const png = b64([...PNG_SIG, ...pngChunk('IHDR', 13), ...pngChunk('IDAT', 0)])
    expect(sniffImageMimeType(png)).toBe('image/png')
  })

  it('detects an animated PNG (acTL before IDAT) as image/apng', () => {
    const apng = b64([
      ...PNG_SIG,
      ...pngChunk('IHDR', 13),
      ...pngChunk('acTL', 8),
      ...pngChunk('IDAT', 0),
    ])
    expect(sniffImageMimeType(apng)).toBe('image/apng')
  })

  it('treats an acTL chunk after IDAT as a still PNG (not APNG)', () => {
    // Per the APNG spec the animation-control chunk must precede image data.
    const png = b64([
      ...PNG_SIG,
      ...pngChunk('IHDR', 13),
      ...pngChunk('IDAT', 0),
      ...pngChunk('acTL', 8),
    ])
    expect(sniffImageMimeType(png)).toBe('image/png')
  })

  it('detects a GIF87a image', () => {
    expect(sniffImageMimeType(b64([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe('image/gif')
  })

  it('detects a GIF89a image', () => {
    expect(sniffImageMimeType(b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
  })

  it('detects a WebP image (RIFF....WEBP)', () => {
    const webp = b64([
      0x52, 0x49, 0x46, 0x46, // "RIFF"
      0x1a, 0x00, 0x00, 0x00, // file size
      0x57, 0x45, 0x42, 0x50, // "WEBP"
      0x56, 0x50, 0x38, 0x20, // "VP8 "
    ])
    expect(sniffImageMimeType(webp)).toBe('image/webp')
  })

  it('detects a JPEG image', () => {
    const jpeg = b64([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46])
    expect(sniffImageMimeType(jpeg)).toBe('image/jpeg')
  })

  it('tolerates whitespace/newlines in the base64 (XML-wrapped payloads)', () => {
    const gif = b64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const wrapped = gif.slice(0, 4) + '\n  ' + gif.slice(4)
    expect(sniffImageMimeType(wrapped)).toBe('image/gif')
  })

  it('returns null for an unrecognized format', () => {
    expect(sniffImageMimeType(b64([0x00, 0x01, 0x02, 0x03, 0x04]))).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(sniffImageMimeType('')).toBeNull()
  })

  it('returns null for invalid base64', () => {
    expect(sniffImageMimeType('!!!!not-base64')).toBeNull()
  })

  it('returns null for data too short to identify', () => {
    expect(sniffImageMimeType(b64([0x89, 0x50]))).toBeNull()
  })
})
