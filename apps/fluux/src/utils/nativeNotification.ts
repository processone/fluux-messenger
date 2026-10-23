import { invoke } from '@tauri-apps/api/core'
import { connectionStore, getBareJid } from '@fluux/sdk'
import { osNotificationSilent } from './notificationSound'
import { communicationTestAvailable } from '@/platform'

export interface NotificationNames {
  title: string
  senderName: string
  roomName?: string
}

export interface CommunicationMetadata {
  senderId: string
  senderName: string
  senderNick?: string
  participantIds?: Record<string, string>
  roomName?: string
  ownNick?: string
  participants?: string[]
}

/** Notification content the callers describe; the sound flag is added when posting. */
export interface NativeDesktopNotification {
  title: string
  body: string
  navType: string
  navTarget: string
  messageId: string | null
  accountId: string | null
  avatarPath: string | null
  communication?: CommunicationMetadata
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
export async function postNativeDesktopNotification(
  payload: NativeDesktopNotification,
  eligible: () => Promise<boolean | NotificationNames> = async () => true,
): Promise<void> {
  try {
    const { communication, ...legacyPayload } = payload
    if (communication && communicationTestAvailable()) {
      const token = await invoke<string | null>('prepare_communication_notification', { payload })
      if (token !== null) {
        // Empty means duplicate/cancelled, not a request to resend on the legacy path.
        if (token) {
          let commit = false
          let names: NotificationNames | undefined
          try {
            const decision = await eligible()
            commit = decision === true || (typeof decision === 'object' && decision !== null)
            if (typeof decision === 'object' && decision !== null) names = decision
          } finally {
            await invoke('finish_communication_notification', { token, commit, ...(names ? { names } : {}) })
          }
        }
        return
      }
      // The captain chose prototype-only revalidation: null retains legacy desktop eligibility.
    }
    await invoke('post_notification', { ...legacyPayload, silent: osNotificationSilent() })
  } catch (error) {
    console.error('[Notifications] Native notification failed:', error)
  }
}
