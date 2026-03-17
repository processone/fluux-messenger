/**
 * Native clipboard image reading for Tauri (Linux/WebKitGTK workaround).
 *
 * WebKitGTK does not reliably expose clipboard image data through the standard
 * ClipboardEvent API. On Linux + Tauri, we fall back to the native
 * tauri-plugin-clipboard-manager to read images directly from the system clipboard.
 */

import { isTauri } from './tauri'

/**
 * Attempt to read an image from the system clipboard using Tauri's native plugin.
 * Returns a File object if an image is found, or null otherwise.
 *
 * This should only be called inside Tauri (desktop), and is most useful on Linux
 * where WebKitGTK's clipboard support for images is incomplete.
 */
export async function readClipboardImage(): Promise<File | null> {
  if (!isTauri()) return null

  try {
    const { readImage } = await import('@tauri-apps/plugin-clipboard-manager')
    const image = await readImage()

    // image.rgba() returns raw RGBA pixel data; image has width/height via size()
    const rgba = await image.rgba()
    if (!rgba || rgba.length === 0) return null

    const { width, height } = await image.size()

    // Encode RGBA data to PNG using an offscreen canvas
    const pngBlob = await rgbaToPng(rgba, width, height)
    if (!pngBlob) return null

    const filename = `clipboard-${Date.now()}.png`
    return new File([pngBlob], filename, { type: 'image/png' })
  } catch {
    // No image in clipboard, or plugin not available — not an error
    return null
  }
}

/**
 * Convert raw RGBA pixel data to a PNG blob using OffscreenCanvas (or fallback to regular canvas).
 */
async function rgbaToPng(rgba: Uint8Array, width: number, height: number): Promise<Blob | null> {
  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height)

  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.putImageData(imageData, 0, 0)
    return canvas.convertToBlob({ type: 'image/png' })
  }

  // Fallback for environments without OffscreenCanvas
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.putImageData(imageData, 0, 0)

  return new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png')
  })
}
