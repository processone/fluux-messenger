import { create } from 'zustand'

/**
 * Transient selection for the read-only "message request" preview shown in the
 * main content pane. Mirrors the search/activity preview-state pattern so the
 * (prop-less) sidebar list can set it directly and ChatLayout can read it
 * without threading a callback through ConversationList.
 */
interface MessageRequestPreviewState {
  /** JID of the stranger whose message thread is being previewed, or null. */
  previewJid: string | null
  setPreviewJid: (jid: string | null) => void
}

export const useMessageRequestPreviewStore = create<MessageRequestPreviewState>((set) => ({
  previewJid: null,
  setPreviewJid: (jid) => set({ previewJid: jid }),
}))

/** Vanilla store handle for non-React reads/writes. */
export const messageRequestPreviewStore = useMessageRequestPreviewStore
