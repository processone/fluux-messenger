import { platform } from '@/platform'
import { setIosBackdrop } from './appearance'

type Rgba = readonly [number, number, number, number]

/**
 * While a field has focus WebKit pans the page up by the keyboard height, so the strip
 * behind the keyboard's rounded top corners is outside the document and shows the native
 * web view and its root view (black or white by system mode, whatever the theme). Document
 * backgrounds cannot reach it; the native side paints it with the color sampled here.
 */

/**
 * An estimate of the color the page shows at a point from flat backgrounds: the first opaque layer
 * from the top of the element stack down, with the translucent layers above it blended on top,
 * nearest layer last. Shadows, gradients, images and filters are not part of it.
 * Layers are read lazily, so nothing below the first opaque one is ever evaluated.
 */
export function visibleColor(stack: Iterable<string>, read: (css: string) => Rgba): readonly [number, number, number] | null {
  const above: Rgba[] = []
  let base: Rgba | null = null
  for (const css of stack) {
    const layer = read(css)
    if (layer[3] === 255) { base = layer; break }
    above.push(layer)
  }
  if (!base) return null
  let [r, g, b] = base
  for (let i = above.length - 1; i >= 0; i--) {
    const [lr, lg, lb, la] = above[i]
    const alpha = la / 255
    r = lr * alpha + r * (1 - alpha)
    g = lg * alpha + g * (1 - alpha)
    b = lb * alpha + b * (1 - alpha)
  }
  return [Math.round(r), Math.round(g), Math.round(b)]
}

let reader: ((css: string) => Rgba) | null = null
function readThroughCanvas(): (css: string) => Rgba {
  if (reader) return reader
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  reader = css => {
    if (!context) return [0, 0, 0, 0]
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = '#000'
    context.fillStyle = css
    context.fillRect(0, 0, 1, 1)
    const d = context.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
  return reader
}

let frame = 0
let watching = false

function sample(): void {
  frame = 0
  const viewport = window.visualViewport
  // Layout coordinates of the last visible row of the current visual viewport. WebKit may still be
  // panning, so this can be stale; the viewport resize and scroll events sample again.
  const bottom = Math.min(Math.floor((viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - 1), window.innerHeight - 1)
  const stack = document.elementsFromPoint(Math.floor(window.innerWidth / 2), Math.max(bottom, 0))
  const backgrounds = function* () { for (const element of stack) yield getComputedStyle(element).backgroundColor }
  const color = visibleColor(backgrounds(), readThroughCanvas())
  if (!color) return
  const hex = `#${color.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
  // The writer skips a color it already holds and retries one native did not confirm on the next event.
  void setIosBackdrop(hex)
}

/**
 * The one owner of the backdrop: any number of callers share a single sample per frame.
 * The native dock notification fires before WebKit has panned the page, and the page moves on
 * later viewport resize and scroll events, so those resample while the keyboard is docked.
 */
export function syncKeyboardBackdrop(): void {
  if (!platform().syncsNativeAppearance) return
  if (!watching) {
    watching = true
    const root = document.documentElement
    new MutationObserver(syncKeyboardBackdrop).observe(root, { attributes: true, attributeFilter: ['data-keyboard-docked'] })
    const whileDocked = () => { if (root.dataset.keyboardDocked === 'true') syncKeyboardBackdrop() }
    window.visualViewport?.addEventListener('resize', whileDocked)
    window.visualViewport?.addEventListener('scroll', whileDocked)
  }
  if (!frame) frame = requestAnimationFrame(sample)
}
