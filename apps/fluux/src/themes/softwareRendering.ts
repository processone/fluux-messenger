/**
 * Software-rendering probe.
 *
 * Why this exists: `@supports (backdrop-filter: blur(1px))` reports a
 * CAPABILITY, never a rendering guarantee. WebKitGTK (#884) and WebView2 on a
 * software-rendered Windows box both advertise backdrop-filter and then paint it
 * as a no-op. The translucency still lands, so a glass panel degrades into a
 * plain see-through hole and modal text becomes unreadable.
 *
 * There is no way to ask the page whether a backdrop-filter actually painted —
 * composited output cannot be read back from the document. The GPU renderer
 * string is a proxy: software rasterisers identify themselves by name, and when
 * one is active backdrop-filter will not composite usefully.
 */

export type RendererClass = 'software' | 'hardware' | 'unknown'

/**
 * Markers that identify a software rasteriser. Matched case-insensitively
 * against the unmasked WebGL renderer string. `warp` is word-anchored because it
 * is short enough to appear inside unrelated product names.
 */
const SOFTWARE_PATTERNS: readonly RegExp[] = [
  /swiftshader/, // Chromium / WebView2 software GL
  /llvmpipe/, // Mesa software rasteriser
  /softpipe/, // Mesa, older
  /lavapipe/, // Mesa software Vulkan
  /swrast/, // Mesa software raster
  /\bwarp\b/, // Direct3D WARP
  /basic render driver/, // "Microsoft Basic Render Driver"
  /apple software renderer/,
  /software rasterizer/,
]

/**
 * Classify a WebGL `UNMASKED_RENDERER_WEBGL` string.
 *
 * Returns 'unknown' for an absent or empty string — the caller MUST treat that
 * as hardware. Browsers legitimately mask the renderer for fingerprinting
 * reasons, and flattening glass for all of them would be a far worse regression
 * than leaving it on for a rare software-rendered machine.
 */
export function classifyRenderer(renderer: string | null | undefined): RendererClass {
  if (!renderer) return 'unknown'
  const value = renderer.toLowerCase()
  return SOFTWARE_PATTERNS.some((pattern) => pattern.test(value)) ? 'software' : 'hardware'
}
