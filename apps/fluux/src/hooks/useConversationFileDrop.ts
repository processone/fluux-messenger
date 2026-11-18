import { useCallback, useEffect, useRef } from 'react'
import { useConversationFileDropStore } from '@/stores/conversationFileDropStore'
import { subscribeToConversationDrop } from '@/utils/tauriFileDrop'
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

  useEffect(() => subscribeToConversationDrop((conversationId, paths) => {
    void readNativeDroppedFile(paths[0]).then(
      (file) => dropFile(conversationId, file),
      (err) => console.error('[useConversationFileDrop] Failed to read dropped file:', err),
    )
  }), [dropFile])

  return dropFile
}
