/**
 * The root font size, following the OS text size where the platform has one.
 *
 * WebKit resolves the `-apple-system-body` font to the body size of the user's
 * Dynamic Type setting (17px at the default size), so measuring it gives the
 * size the user chose in iOS Settings.
 */

/** Body text size, in px, of the user's OS text setting, or null when unknown. */
export function measureSystemBodySize(): number | null {
  if (typeof document === 'undefined' || !document.body) return null
  const probe = document.createElement('span')
  probe.style.font = '-apple-system-body'
  probe.style.position = 'absolute'
  probe.style.visibility = 'hidden'
  document.body.appendChild(probe)
  try {
    // A webview that does not know the font keeps the inline value empty.
    if (!probe.style.font) return null
    const size = parseFloat(getComputedStyle(probe).fontSize)
    return Number.isFinite(size) && size > 0 ? size : null
  } finally {
    probe.remove()
  }
}

/**
 * The `font-size` of the root element: the app's font size (a percentage) of
 * the OS body size when known, otherwise of the browser default.
 */
export function rootFontSize(fontSizePercent: number, systemBodyPx: number | null): string {
  if (systemBodyPx === null) return `${fontSizePercent}%`
  return `${Math.round(systemBodyPx * fontSizePercent) / 100}px`
}
