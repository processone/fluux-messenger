import { useCallback, useEffect, useRef } from 'react'
import { chatStore } from '@fluux/sdk'
import { useConversationFileDropStore } from '@/stores/conversationFileDropStore'
import { subscribeToConversationDrop, currentNativeDropSequence } from '@/utils/tauriFileDrop'
import { readNativeDroppedFile } from '@/utils/nativeDroppedFile'

/**
 * Drop of a file on a sidebar conversation: opens that conversation and hands
 * the file to its chat view, which stages it in the composer. Nothing is
 * uploaded or sent here; that only happens when the user presses Send.
 *
 * @param select Opens a conversation, as a click on its row does.
 * @returns The handler for a file dropped on a row (browser drops); desktop
 *   drops are received by the window and routed here by their position.
 */
export function useConversationFileDrop(select: (conversationId: string) => void) {
  const selectRef = useRef(select)
  selectRef.current = select

  const dropFile = useCallback((conversationId: string, file: File) => {
    selectRef.current(conversationId)
    useConversationFileDropStore.getState().offer(conversationId, file)
  }, [])

  useEffect(() => {
    // A read that finishes late is dropped when a newer drop (on a row or on the
    // chat), another conversation selection, or this list going away came first.
    let mounted = true
    const unsubscribe = subscribeToConversationDrop((conversationId, paths) => {
      const drop = currentNativeDropSequence()
      const target = chatStore.getState().activationTarget
      void readNativeDroppedFile(paths[0]).then(
        (file) => {
          if (!mounted || drop !== currentNativeDropSequence() || target !== chatStore.getState().activationTarget) return
          dropFile(conversationId, file)
        },
        (err) => console.error('[useConversationFileDrop] Failed to read dropped file:', err),
      )
    })
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [dropFile])

  return dropFile
}
