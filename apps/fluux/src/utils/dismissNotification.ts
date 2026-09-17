import { connectionStore, getBareJid } from '@fluux/sdk'
import { isMobileTauri } from '@/utils/tauriPlatform'
import { webTag, type NavType } from './notificationNavigation'
import { serviceWorkerRegistration } from './webNotification'
import { platform } from '@/platform'

export type { NavType }

/** Notifications live in the OS notification centre, so dismissal is native.
 *  Read at call time so a test can state a host per case. */
function inTauri(): boolean {
  return platform().notificationsManagedByOS
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
    const jid = connectionStore.getState().jid
    const accountId = jid ? getBareJid(jid) : null
    if (inTauri()) {
      if (await isMobileTauri()) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('dismiss_notifications', {
        navType,
        navTarget,
        accountId,
      })
      return
    }

    // Web PWA: notifications were posted via ServiceWorkerRegistration.showNotification.
    const registration = await serviceWorkerRegistration()
    if (registration) {
      const notifications = await registration.getNotifications({ tag: webTag(navType, navTarget, accountId) })
      notifications.forEach((n) => n.close())
    }
  } catch {
    // Best-effort: dismissing a read notification is a nice-to-have.
  }
}
