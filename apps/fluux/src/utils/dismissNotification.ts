import { isMacOSDesktop } from '@/utils/tauriPlatform'
import { webTag, type NavType } from './notificationNavigation'

export type { NavType }

/** Running inside the Tauri desktop app. Checked at call time (not module load)
 *  so tests can toggle it. */
function inTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Remove the delivered notification(s) for a single conversation/room when it
 * is read, leaving other conversations' notifications untouched. Best-effort
 * and platform-specific:
 * - macOS Tauri: native UNUserNotificationCenter command, keyed by identifier
 *   `"<navType>:<navTarget>"`.
 * - Windows/Linux Tauri: no-op. The notification plugin can only reference a
 *   sent notification by a 32-bit integer id, not by our JID-based tag, so
 *   there is no reliable way to remove a single conversation's notification;
 *   it is left to auto-expire.
 * - Web (PWA): service worker registration, keyed by tag.
 */
export async function dismissNotification(navType: NavType, navTarget: string): Promise<void> {
  try {
    if (await isMacOSDesktop()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('remove_delivered_notifications', {
        identifiers: [`${navType}:${navTarget}`],
      })
      return
    }

    if (inTauri()) {
      // Windows/Linux Tauri: no per-conversation removal available (see above).
      return
    }

    // Web PWA: notifications were posted via ServiceWorkerRegistration.showNotification.
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      const tag = webTag(navType, navTarget)
      const registration = await navigator.serviceWorker.ready
      const notifications = await registration.getNotifications({ tag })
      notifications.forEach((n) => n.close())
    }
  } catch {
    // Best-effort: dismissing a read notification is a nice-to-have.
  }
}
