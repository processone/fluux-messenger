import { invoke } from '@tauri-apps/api/core'
import { connectionStore, getBareJid } from '@fluux/sdk'
import { osNotificationSilent } from './notificationSound'

/** Notification content the callers describe; the sound flag is added when posting. */
export interface NativeDesktopNotification {
  title: string
  body: string
  navType: string
  navTarget: string
  messageId: string | null
  accountId: string | null
  avatarPath: string | null
}

/** Bare JID of the signed-in account, which scopes notification routing and dismissal. */
export function currentAccountId(): string | null {
  const jid = connectionStore.getState().jid
  return jid ? getBareJid(jid) : null
}

/**
 * Post through the native desktop backend, which routes a click back through
 * the `notification-activated` event. Never rejects: a failed banner must not
 * break the caller.
 */
export async function postNativeDesktopNotification(payload: NativeDesktopNotification): Promise<void> {
  try {
    await invoke('post_notification', { ...payload, silent: osNotificationSilent() })
  } catch (error) {
    console.error('[Notifications] Native notification failed:', error)
  }
}
