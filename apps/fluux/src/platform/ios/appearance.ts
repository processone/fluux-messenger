import { platform } from '@/platform'

// Tauri runs each async command as its own task, so two overlapping calls can reach the native
// side in either order. One sender keeps a single command in flight and, when values change
// meanwhile, sends only the latest snapshot next. A missing style means "follow the system", so
// every snapshot carries both values.
let style: 'light' | 'dark' | null = null
let background: string | undefined
let acknowledged: string | undefined
let draining: Promise<void> | null = null
let changed = false

async function drain(): Promise<void> {
  do {
    changed = false
    const snapshot = { style, background }
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('plugin:ios-feedback|set_appearance', snapshot)
      acknowledged = snapshot.background ?? acknowledged
    } catch {
      // The next change, or a later sample of the same color, sends it again.
    }
  } while (changed)
}

function send(): Promise<void> {
  if (!platform().syncsNativeAppearance) return Promise.resolve()
  changed = true
  draining ??= drain().finally(() => { draining = null })
  return draining
}

/** Tells native views drawn over the app which theme to use; `null` follows the system. */
export function setIosAppearance(next: 'light' | 'dark' | null): void {
  style = next
  void send()
}

/**
 * Paints the native web view behind the keyboard (`#rrggbb`); true once native confirmed that color.
 * The latest request is recorded before deciding whether a write is needed: an idle writer that already
 * holds this color skips it, while a write in flight is followed by one for the latest color.
 */
export async function setIosBackdrop(color: string): Promise<boolean> {
  background = color
  if (!draining && acknowledged === color) return true
  await send()
  return acknowledged === color
}
