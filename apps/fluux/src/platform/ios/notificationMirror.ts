/** Compatibility entry points for the iOS notification lifecycle. The Apple conversation mirror
 * is shared with the native macOS unread widget; only the IPC destination differs. */
export {
  clearAppleConversationMirror as clearIOSNotificationMirror,
  startAppleConversationMirror as startIOSNotificationMirror,
  pushSenderNames,
  type PushSenderNames,
} from '../apple/conversationMirror'
