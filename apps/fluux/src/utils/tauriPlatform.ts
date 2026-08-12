/**
 * Which OS the desktop shell reports, refined beyond what `@/platform` can see.
 *
 * `platform().os` sniffs `navigator` synchronously and cannot tell a phone from
 * a desktop — Android reports `Linux`. The Tauri OS plugin answers exactly, but
 * only asynchronously, which is why this lives apart rather than as a member of
 * the capability record. Folding it in would mean an async platform init.
 */
import { platform } from '@/platform'

let cachedPlatform: string | undefined

async function getTauriPlatform(): Promise<string | undefined> {
  if (platform().shell !== 'desktop') return undefined
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
