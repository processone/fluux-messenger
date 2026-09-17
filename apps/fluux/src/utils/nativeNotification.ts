import { invoke } from '@tauri-apps/api/core'
import { connectionStore, getBareJid } from '@fluux/sdk'

/** Payload of the native `post_notification` command. */
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
    await invoke('post_notification', { ...payload })
  } catch (error) {
    console.error('[Notifications] Native notification failed:', error)
  }
}
