import { invoke } from '@tauri-apps/api/core'
import type { Options } from '@tauri-apps/plugin-notification'

/**
 * Post a notification through the Tauri notification plugin on mobile.
 * Desktop platforms use native Rust backends so notification clicks can be
 * routed back into the application.
 *
 * Calls the plugin command directly rather than going through the plugin's
 * `sendNotification()`: that wrapper is synchronous (`(options) => void`) and
 * builds `new window.Notification(...)`, whose injected shim starts the invoke
 * inside a floating async IIFE and drops the promise. A rejected command — ACL
 * denial, a payload that fails to deserialize into `NotificationData` — was
 * therefore swallowed with no trace on any platform. Awaiting it here puts the
 * failure on the console, which main.rs forwards into fluux.log so it shows up
 * in bug reports.
 *
 * The payload is what the shim would have sent: `{ options }` with `title`
 * already merged in by the caller.
 *
 * Scope note: this can only observe failures up to the command boundary. The
 * mobile plugin owns the later OS delivery lifecycle.
 *
 * Never rejects: callers post notifications fire-and-forget, and a failed
 * banner must not break message handling.
 */
export async function postPluginNotification(options: Options): Promise<void> {
  try {
    await invoke('plugin:notification|notify', { options })
  } catch (error) {
    console.error('[Notifications] Plugin notification failed:', error)
  }
}
