// Rewrites an 8-bit RGBA PNG as RGB, composited on white.
//
// App Store Connect rejects an app icon with an alpha channel, even a fully
// opaque one (ITMS-90717). Lossless, with no image library.
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync, crc32 } from 'node:zlib'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function chunks(png) {
  const list = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    list.push({ type: png.toString('latin1', offset + 4, offset + 8), data: png.subarray(offset + 8, offset + 8 + length) })
    offset += 12 + length
  }
  return list
}

function chunk(type, data) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])))
  return Buffer.concat([head, data, crc])
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Returns `png` without its alpha channel, or unchanged when it has none. */
export function opaquePng(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file.')
  const list = chunks(png)
  const header = list[0].data
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4)
  const [depth, colorType, , , interlace] = header.subarray(8, 13)
  if (colorType === 2) return png
  if (colorType !== 6 || depth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG (color type ${colorType}, depth ${depth}, interlace ${interlace}).`)
  }

  const raw = inflateSync(Buffer.concat(list.filter((c) => c.type === 'IDAT').map((c) => c.data)))
  const stride = width * 4
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0
      const upLeft = x >= 4 && y > 0 ? rgba[(y - 1) * stride + x - 4] : 0
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter]
      if (predictor === undefined) throw new Error(`Unknown PNG filter ${filter}.`)
      rgba[y * stride + x] = (line[x] + predictor) & 0xff
    }
  }

  const rgb = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = y * stride + x * 4
      const alpha = rgba[source + 3]
      for (let channel = 0; channel < 3; channel++) {
        rgb[y * (width * 3 + 1) + 1 + x * 3 + channel] =
          Math.round((rgba[source + channel] * alpha + 255 * (255 - alpha)) / 255)
      }
    }
  }

  const rgbHeader = Buffer.from(header)
  rgbHeader[9] = 2
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', rgbHeader),
    ...list.filter((c) => !['IHDR', 'IDAT', 'IEND', 'tRNS'].includes(c.type)).map((c) => chunk(c.type, c.data)),
    chunk('IDAT', deflateSync(rgb, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

export function makePngOpaque(path) {
  writeFileSync(path, opaquePng(readFileSync(path)))
}
