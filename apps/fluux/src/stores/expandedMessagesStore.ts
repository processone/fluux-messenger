import { create } from 'zustand'

/**
 * Store for tracking which messages are expanded (for long message collapsing).
 *
 * This is session-based (in-memory only) - expanded state resets on refresh.
 * Follows Discord/Slack behavior:
 * - Long messages are collapsed by default
 * - User clicks "Show more" to expand
 * - Expanded state persists while scrolling within the session
 * - State clears on page refresh
 */
interface ExpandedMessagesState {
  /** Set of message IDs that have been expanded by the user */
  expandedIds: Set<string>

  /** Mark a message as expanded */
  expand: (messageId: string) => void

  /** Mark a message as collapsed */
  collapse: (messageId: string) => void

  /** Toggle the expanded state of a message */
  toggle: (messageId: string) => void

  /** Check if a message is expanded */
  isExpanded: (messageId: string) => boolean

  /** Clear all expanded states (e.g., on disconnect) */
  clear: () => void
}

export const useExpandedMessagesStore = create<ExpandedMessagesState>((set, get) => ({
  expandedIds: new Set(),

  expand: (messageId: string) => {
    set((state) => {
      const newSet = new Set(state.expandedIds)
      newSet.add(messageId)
      return { expandedIds: newSet }
    })
  },

  collapse: (messageId: string) => {
    set((state) => {
      const newSet = new Set(state.expandedIds)
      newSet.delete(messageId)
      return { expandedIds: newSet }
    })
  },

  toggle: (messageId: string) => {
    const { expandedIds } = get()
    if (expandedIds.has(messageId)) {
      get().collapse(messageId)
    } else {
      get().expand(messageId)
    }
  },

  isExpanded: (messageId: string) => {
    return get().expandedIds.has(messageId)
  },

  clear: () => {
    set({ expandedIds: new Set() })
  },
}))
