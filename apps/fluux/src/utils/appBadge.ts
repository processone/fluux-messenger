/**
 * Badging API wrapper for the installed PWA icon (complements the favicon
 * badge, which only covers a visible browser tab). Feature-detected and
 * best-effort: unsupported platforms silently no-op.
 *
 * Counterpart when the app is CLOSED: sw.ts sets an argumentless
 * setAppBadge() dot on push, since only the running app knows the real count.
 */
export async function setWebAppBadge(count: number): Promise<void> {
  const nav = navigator as Navigator & {
    setAppBadge?: (contents?: number) => Promise<void>
    clearAppBadge?: () => Promise<void>
  }
  if (!nav.setAppBadge) return
  try {
    if (count > 0) await nav.setAppBadge(count)
    else await nav.clearAppBadge?.()
  } catch {
    // Best-effort — the favicon badge remains as fallback.
  }
}
