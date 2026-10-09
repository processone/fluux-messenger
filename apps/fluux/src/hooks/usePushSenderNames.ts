import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { startIOSNotificationPreviews } from '@/platform/ios/notificationPreviews'
import { startIOSNotificationMirror } from '@/platform/ios/notificationMirror'

export { pushSenderNames, type PushSenderNames } from '@/platform/ios/notificationMirror'

/** Keeps the remote-notification mirror synchronized for the mounted session. */
export function usePushSenderNames(client?: XMPPClient): void {
  useEffect(() => startIOSNotificationMirror(), [])
  useEffect(() => client ? startIOSNotificationPreviews(client) : undefined, [client])
}
