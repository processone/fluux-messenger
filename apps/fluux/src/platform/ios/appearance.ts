import { platform } from '@/platform'

/** Tells native views drawn over the app which theme to use; `null` follows the system. */
export function setIosAppearance(style: 'light' | 'dark' | null): void {
  if (!platform().syncsNativeAppearance) return
  void import('@tauri-apps/api/core').then(({ invoke }) => {
    if (platform().syncsNativeAppearance) return invoke('plugin:ios-feedback|set_appearance', { style })
  }).catch(() => {})
}
