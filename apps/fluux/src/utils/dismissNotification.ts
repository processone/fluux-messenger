import { connectionStore, getBareJid } from '@fluux/sdk'
import { isMobileTauri } from '@/utils/tauriPlatform'
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
 * - Desktop Tauri: native backend, grouped by account + conversation.
 *   Windows currently treats the command as best-effort because the inbox
 *   WinRT wrapper does not expose notification history tags.
 * - Mobile Tauri: no-op; mobile lifecycle owns notification dismissal.
 * - Web (PWA): service worker registration, keyed by tag.
 */
export async function dismissNotification(navType: NavType, navTarget: string): Promise<void> {
  try {
    if (inTauri()) {
      if (await isMobileTauri()) return
      const { invoke } = await import('@tauri-apps/api/core')
      const jid = connectionStore.getState().jid
      await invoke('dismiss_notifications', {
        navType,
        navTarget,
        accountId: jid ? getBareJid(jid) : null,
      })
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
