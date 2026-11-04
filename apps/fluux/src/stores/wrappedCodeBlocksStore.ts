import { create } from 'zustand'

/**
 * Tracks which code blocks the user switched to "Wrap lines" (display only).
 *
 * In-memory only, like expandedMessagesStore: the choice survives scrolling
 * and switching conversations within the session and resets on restart.
 * A block is identified by its message id and its position among the code
 * blocks of that message, so two blocks in one message wrap independently.
 */
interface WrappedCodeBlocksState {
  /** messageId -> indexes of the wrapped code blocks in that message */
  wrapped: ReadonlyMap<string, ReadonlySet<number>>

  /** Flip the wrapped state of one code block */
  toggle: (messageId: string, blockIndex: number) => void

  /** Check whether a code block is wrapped */
  isWrapped: (messageId: string, blockIndex: number) => boolean

  /** Number of wrapped blocks in a message (changes whenever one is toggled) */
  countFor: (messageId: string) => number

  /** Clear all wrapped states */
  clear: () => void
}

export const useWrappedCodeBlocksStore = create<WrappedCodeBlocksState>((set, get) => ({
  wrapped: new Map(),

  toggle: (messageId, blockIndex) => {
    set((state) => {
      const next = new Map(state.wrapped)
      const blocks = new Set(next.get(messageId))
      if (!blocks.delete(blockIndex)) blocks.add(blockIndex)
      if (blocks.size > 0) next.set(messageId, blocks)
      else next.delete(messageId)
      return { wrapped: next }
    })
  },

  isWrapped: (messageId, blockIndex) => get().wrapped.get(messageId)?.has(blockIndex) ?? false,

  countFor: (messageId) => get().wrapped.get(messageId)?.size ?? 0,

  clear: () => set({ wrapped: new Map() }),
}))
