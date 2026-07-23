/** Cached Tauri platform checks used to select desktop/mobile native APIs. */
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

let cachedPlatform: string | undefined

async function getTauriPlatform(): Promise<string | undefined> {
  if (!isTauri) return undefined
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
