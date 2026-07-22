/**
 * Renders the Windows installer artwork in this directory.
 *
 * Each *.html here is a self-contained, exactly-sized layout (see shared.css)
 * referencing committed brand assets relatively, so it renders offline. Output
 * is a 24-bit uncompressed BMP — the only format WiX v3 and NSIS accept for
 * these slots — written to apps/fluux/src-tauri/installer/windows/, plus a PNG
 * of the same pixels in preview/ so the artwork is reviewable in a diff
 * (GitHub renders PNG, not BMP).
 *
 * Rendered 1:1, never at 2x: both installers stretch a bitmap whose size does
 * not match the slot, so a 2x capture would come out soft. The size assertion
 * below is what keeps a stray deviceScaleFactor from shipping blurry art.
 *
 * Usage: node scripts/installer-art/render.mjs [name-filter]
 */
import { chromium } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(dir, '../../apps/fluux/src-tauri/installer/windows')
const previewDir = resolve(dir, 'preview')

/** Slot sizes are fixed by WiX v3 / NSIS — see each HTML file's header. */
const TARGETS = [
  { name: 'wix-banner', width: 493, height: 58 },
  { name: 'wix-dialog', width: 493, height: 312 },
  { name: 'nsis-header', width: 150, height: 57 },
  { name: 'nsis-sidebar', width: 164, height: 314 },
]

/**
 * Pack RGBA pixels into a 24-bit BI_RGB bitmap: BGR channel order, rows padded
 * to a 4-byte boundary and stored bottom-up (a positive height). Alpha is
 * dropped — every layout paints an opaque background.
 */
function encodeBmp24(rgba, width, height) {
  const rowSize = (width * 3 + 3) & ~3
  const pixelBytes = rowSize * height
  const buf = Buffer.alloc(54 + pixelBytes)

  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(buf.length, 2)
  buf.writeUInt32LE(54, 10) // pixel data offset
  buf.writeUInt32LE(40, 14) // BITMAPINFOHEADER
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26) // planes
  buf.writeUInt16LE(24, 28) // bits per pixel
  buf.writeUInt32LE(0, 30) // BI_RGB, uncompressed
  buf.writeUInt32LE(pixelBytes, 34)
  buf.writeInt32LE(2835, 38) // 72 DPI, in pixels per metre
  buf.writeInt32LE(2835, 42)

  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4
    let dst = 54 + y * rowSize
    for (let x = 0; x < width; x++) {
      const src = srcRow + x * 4
      buf[dst++] = rgba[src + 2]
      buf[dst++] = rgba[src + 1]
      buf[dst++] = rgba[src]
    }
  }
  return buf
}

/** Decodes a PNG buffer to raw RGBA by round-tripping it through a canvas. */
async function decodePng(page, png) {
  const decoded = await page.evaluate(async (url) => {
    const img = new Image()
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.naturalWidth
    canvas.height = img.naturalHeight
    canvas.getContext('2d').drawImage(img, 0, 0)
    const { data } = canvas
      .getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height)
    let binary = ''
    const chunk = 0x8000
    for (let i = 0; i < data.length; i += chunk) {
      binary += String.fromCharCode.apply(null, data.subarray(i, i + chunk))
    }
    return { width: canvas.width, height: canvas.height, base64: btoa(binary) }
  }, 'data:image/png;base64,' + png.toString('base64'))

  return { ...decoded, rgba: Buffer.from(decoded.base64, 'base64') }
}

const filter = process.argv[2]
const targets = TARGETS.filter((t) => !filter || t.name.includes(filter))
if (!targets.length) {
  console.error(`no installer art matches "${filter}"`)
  process.exit(1)
}

mkdirSync(outDir, { recursive: true })
mkdirSync(previewDir, { recursive: true })

const browser = await chromium.launch()

for (const target of targets) {
  const page = await browser.newPage({
    viewport: { width: target.width, height: target.height },
    deviceScaleFactor: 1,
  })
  await page.goto('file://' + resolve(dir, target.name + '.html'))
  await page.waitForTimeout(200)

  const png = await page.screenshot()
  const { width, height, rgba } = await decodePng(page, png)
  await page.close()

  if (width !== target.width || height !== target.height) {
    throw new Error(
      `${target.name}: rendered ${width}×${height}, expected ` +
        `${target.width}×${target.height} — the installer would stretch this`,
    )
  }

  writeFileSync(resolve(outDir, target.name + '.bmp'), encodeBmp24(rgba, width, height))
  writeFileSync(resolve(previewDir, target.name + '.png'), png)
  console.log(`rendered ${target.name}.bmp (${width}×${height})`)
}

await browser.close()
