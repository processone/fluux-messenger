/**
 * Which OS the native shell reports.
 *
 * The lazy import keeps callers asynchronous while the platform capability
 * record handles the iOS distinction synchronously at startup.
 */
import { platform } from '@/platform'

let cachedPlatform: string | undefined

async function getTauriPlatform(): Promise<string | undefined> {
  if (platform().shell === 'web') return undefined
  if (cachedPlatform !== undefined) return cachedPlatform
  try {
    const { platform } = await import('@tauri-apps/plugin-os')
    cachedPlatform = await platform()
  } catch {
    cachedPlatform = ''
  }
  return cachedPlatform
}

export async function isMacOSDesktop(): Promise<boolean> {
  return (await getTauriPlatform()) === 'macos'
}

export async function isMobileTauri(): Promise<boolean> {
  const platform = await getTauriPlatform()
  return platform === 'ios' || platform === 'android'
}
