import { create } from 'zustand'

/**
 * A file dropped on a sidebar conversation, waiting to be staged in that
 * conversation's composer.
 *
 * The drop switches conversations first, and the chat view clears its staged
 * attachment on every switch. So the file travels here: the chat view takes it
 * once the target conversation is the open one and stages it. Staging only
 * previews the file; nothing is uploaded until the user presses Send.
 */
export interface DroppedFile {
  conversationId: string
  file: File
}

interface ConversationFileDropState {
  pending: DroppedFile | null
  offer: (conversationId: string, file: File) => void
  /** Removes the offer if it is still the one given. */
  take: (offer: DroppedFile) => void
}

export const useConversationFileDropStore = create<ConversationFileDropState>((set, get) => ({
  pending: null,
  offer: (conversationId, file) => set({ pending: { conversationId, file } }),
  take: (offer) => {
    if (get().pending === offer) set({ pending: null })
  },
}))
