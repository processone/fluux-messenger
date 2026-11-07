import { useEffect } from 'react'
import type { XMPPClient } from '@fluux/sdk/core'
import { startIOSNotificationPreviews } from '@/platform/ios/notificationPreviews'
import { startIOSShareSuggestions } from '@/platform/ios/shareSuggestions'
import { startIOSNotificationSounds } from '@/platform/ios/notificationSounds'
import { startAppleConversationMirror } from '@/platform/apple/conversationMirror'

export { pushSenderNames, type PushSenderNames } from '@/platform/apple/conversationMirror'

/** Keeps the Apple shared-conversation mirror synchronized for the mounted session. */
export function usePushSenderNames(client?: XMPPClient): void {
  useEffect(() => startAppleConversationMirror(), [])
  useEffect(() => startIOSNotificationSounds(), [])
  useEffect(() => startIOSShareSuggestions(), [])
  useEffect(() => client ? startIOSNotificationPreviews(client) : undefined, [client])
}
