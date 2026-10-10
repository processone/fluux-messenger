import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { startIOSNotificationPreviews } from '@/platform/ios/notificationPreviews'
import { startIOSShareSuggestions } from '@/platform/ios/shareSuggestions'
import { startIOSNotificationSounds } from '@/platform/ios/notificationSounds'
import { startIOSNotificationMirror } from '@/platform/ios/notificationMirror'

export { pushSenderNames, type PushSenderNames } from '@/platform/ios/notificationMirror'

/** Keeps the remote-notification mirror synchronized for the mounted session. */
export function usePushSenderNames(client?: XMPPClient): void {
  useEffect(() => startIOSNotificationMirror(), [])
  useEffect(() => startIOSNotificationSounds(), [])
  useEffect(() => startIOSShareSuggestions(), [])
  useEffect(() => client ? startIOSNotificationPreviews(client) : undefined, [client])
}
