import { useEffect } from 'react'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useMessageRequestPreviewStore } from '@/stores/messageRequestPreviewStore'
import { useRouteSync } from './useRouteSync'

export const APP_NAME = 'Fluux Messenger'

/** The window title: the app name, then the open conversation when there is one. */
export function formatWindowTitle(conversationName: string | null): string {
  return conversationName ? `${APP_NAME} — ${conversationName}` : APP_NAME
}

/**
 * Name of the conversation or room shown in the main pane, or null when the
 * pane shows something else.
 *
 * Follows the order ChatLayout renders in: settings and a message-request
 * preview replace the conversation even while one stays active underneath, and
 * a room takes precedence over a one-to-one chat.
 */
export function useOpenConversationName(): string | null {
  const { sidebarView } = useRouteSync()
  const previewJid = useMessageRequestPreviewStore((s) => s.previewJid)
  // Each selector returns null for "none active" and a string otherwise, so an
  // active room whose name is not known yet still hides the chat behind it.
  const roomName = useRoomStore((s) =>
    s.activeRoomJid ? (s.rooms.get(s.activeRoomJid)?.name ?? '') : null
  )
  const chatName = useChatStore((s) =>
    s.activeConversationId ? (s.conversations.get(s.activeConversationId)?.name ?? '') : null
  )
  if (sidebarView === 'settings' || previewJid) return null
  return (roomName ?? chatName) || null
}

async function setNativeWindowTitle(title: string): Promise<void> {
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window')
    await getCurrentWindow().setTitle(title)
  } catch {
    // The taskbar keeps the previous title; the in-app title is unaffected.
  }
}

/**
 * Keep the OS window title (taskbar, Alt+Tab) equal to `title` while mounted,
 * and hand it back to the bare app name on unmount.
 */
export function useNativeWindowTitle(title: string): void {
  useEffect(() => {
    void setNativeWindowTitle(title)
  }, [title])
  useEffect(() => () => {
    void setNativeWindowTitle(APP_NAME)
  }, [])
}
