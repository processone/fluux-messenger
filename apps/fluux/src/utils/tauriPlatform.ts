/**
 * Cached check for "running in the Tauri desktop app on macOS".
 * Used to route notification posting through the native UNUserNotificationCenter
 * command on macOS while other platforms keep the Tauri notification plugin.
 */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cached: boolean | undefined

export async function isMacOSDesktop(): Promise<boolean> {
  if (!isTauri) return false
  if (cached !== undefined) return cached
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    cached = (await platform()) === 'macos'
  } catch {
    cached = false
  }
  return cached
}
