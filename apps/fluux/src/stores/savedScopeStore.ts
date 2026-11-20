import { create } from 'zustand'

/**
 * The conversation the Saved list is narrowed to, or null for every saved message.
 *
 * A conversation header's Saved button sets it before opening the Saved tab, the
 * same way Search in conversation scopes a search. It lives only in memory: it is
 * cleared when the Saved tab is left.
 */
interface SavedScopeState {
  conversationJid: string | null
  setScope: (conversationJid: string | null) => void
}

export const useSavedScopeStore = create<SavedScopeState>((set) => ({
  conversationJid: null,
  setScope: (conversationJid) => set({ conversationJid }),
}))
