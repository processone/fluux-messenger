import { platform } from '@/platform'

// Both values travel in one command, and a missing style means "follow the system",
// so each update resends the other's last value instead of resetting it.
let style: 'light' | 'dark' | null = null
let background: string | undefined

function send(): void {
  if (!platform().syncsNativeAppearance) return
  void import('@tauri-apps/api/core').then(({ invoke }) => {
    if (platform().syncsNativeAppearance) return invoke('plugin:ios-feedback|set_appearance', { style, background })
  }).catch(() => {})
}

/** Tells native views drawn over the app which theme to use; `null` follows the system. */
export function setIosAppearance(next: 'light' | 'dark' | null): void {
  style = next
  send()
}

/** Paints the native web view behind the keyboard; `color` is `#rrggbb`. */
export function setIosBackdrop(color: string): void {
  background = color
  send()
}
