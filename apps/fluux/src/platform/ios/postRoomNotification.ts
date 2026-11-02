import { invoke } from '@tauri-apps/api/core'
import type { Options } from '@tauri-apps/plugin-notification'
import { postPluginNotification } from '@/utils/postPluginNotification'

/**
 * Post an iOS room notification through the push plugin, which gives it the room picture and
 * participants a push carries. Falls back to the notification plugin so a failure never loses the message.
 */
export async function postIOSRoomNotification(
  options: Options,
  from: string,
  superseded: () => boolean | Promise<boolean> = () => false,
): Promise<void> {
  try {
    const extra = Object.fromEntries(Object.entries(options.extra ?? {}).filter(([, value]) => typeof value === 'string'))
    if (await superseded()) return
    await invoke('plugin:push|post_local_notification', {
      message: { title: options.title, body: options.body ?? '', from, extra },
    })
  } catch (error) {
    console.error('[Notifications] Room notification with picture failed:', error)
    await postPluginNotification({ ...options, attachments: undefined }, undefined, superseded)
  }
}
