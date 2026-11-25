import { platform } from '@/platform'

type Rgb = readonly [number, number, number]

let lastPainted = ''

/**
 * WebKit pans the page up by the keyboard height, so the strip behind the keyboard's
 * rounded top corners lies outside the document and shows the web view's own
 * background (black or white by system mode). Only the web view can paint it.
 */
function readThroughCanvas(): (css: string) => readonly [number, number, number, number] {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  return css => {
    if (!context) return [0, 0, 0, 0]
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = '#000'
    context.fillStyle = css
    context.fillRect(0, 0, 1, 1)
    const d = context.getImageData(0, 0, 1, 1).data
    return [d[0], d[1], d[2], d[3]]
  }
}

/** The first opaque color from the top of the element stack down. */
export function firstOpaque(stack: readonly string[], read: (css: string) => readonly [number, number, number, number]): Rgb | null {
  for (const css of stack) {
    const [r, g, b, a] = read(css)
    if (a === 255) return [r, g, b]
  }
  return null
}

/** Paints the web view behind the keyboard in the color of the screen just above it. */
export function syncKeyboardBackdrop(): void {
  if (!platform().syncsNativeAppearance) return
  const viewport = window.visualViewport
  const bottom = Math.floor((viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - 1)
  const stack = document.elementsFromPoint(Math.floor(window.innerWidth / 2), Math.min(bottom, window.innerHeight - 1))
  const color = firstOpaque(stack.map(element => getComputedStyle(element).backgroundColor), readThroughCanvas())
  if (!color) return
  const key = color.join(',')
  if (key === lastPainted) return
  lastPainted = key
  void import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) => getCurrentWebview().setBackgroundColor([color[0], color[1], color[2], 255]))
    .catch(() => { lastPainted = '' })
}

/** Repaints whenever the keyboard docks or undocks; theme changes call syncKeyboardBackdrop directly. */
export function watchKeyboardBackdrop(): () => void {
  if (!platform().syncsNativeAppearance) return () => {}
  const observer = new MutationObserver(syncKeyboardBackdrop)
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-keyboard-docked'] })
  return () => observer.disconnect()
}
