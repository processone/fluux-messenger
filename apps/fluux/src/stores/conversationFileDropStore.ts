import { create } from 'zustand'
import { getStorageScopeJid, chatStore } from '@fluux/sdk'

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
  /** The account that was signed in when the file was dropped; another account never receives it. */
  account: string | null
}


interface ConversationFileDropState {
  pending: DroppedFile | null
  /** Call right after selecting the conversation. */
  offer: (conversationId: string, file: File) => void
  /** Removes the offer if it is still the one given. */
  take: (offer: DroppedFile) => void
}

// The file belongs to the activation of its conversation. Once the user asks for
// another conversation (or none) the drop is abandoned, even if the first one
// is still loading; asking for the same conversation again (route sync) keeps it.
// Watching starts with the first offer, so importing this store has no side effect.
let watching = false
function watchActivations() {
  if (watching) return
  watching = true
  chatStore.subscribe((state, prev) => {
    if (state.activationTarget === prev.activationTarget) return
    const { pending, take } = useConversationFileDropStore.getState()
    if (pending && pending.conversationId !== state.activationTarget) take(pending)
  })
}

export const useConversationFileDropStore = create<ConversationFileDropState>((set, get) => ({
  pending: null,
  offer: (conversationId, file) => {
    watchActivations()
    set({ pending: { conversationId, file, account: getStorageScopeJid() } })
  },
  take: (offer) => {
    if (get().pending === offer) set({ pending: null })
  },
}))

