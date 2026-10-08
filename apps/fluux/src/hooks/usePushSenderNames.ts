import { useEffect } from 'react'
import { startIOSNotificationMirror } from '@/platform/ios/notificationMirror'

export { pushSenderNames, type PushSenderNames } from '@/platform/ios/notificationMirror'

/** Keeps the remote-notification mirror synchronized for the mounted session. */
export function usePushSenderNames(): void {
  useEffect(() => startIOSNotificationMirror(), [])
}
