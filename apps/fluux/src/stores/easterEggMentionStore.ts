import { create } from 'zustand'

export interface PendingEasterEgg {
  id: string
  conversationId: string
  animation: string
  senderName: string
}

interface EasterEggMentionState {
  mentions: Map<string, PendingEasterEgg>
  add: (egg: PendingEasterEgg) => void
  dismiss: (conversationId: string) => void
}

export const useEasterEggMentionStore = create<EasterEggMentionState>((set) => ({
  mentions: new Map(),
  // Latest egg wins: one pending egg per conversation.
  add: (egg) => set((s) => {
    const next = new Map(s.mentions)
    next.set(egg.conversationId, egg)
    return { mentions: next }
  }),
  dismiss: (conversationId) => set((s) => {
    if (!s.mentions.has(conversationId)) return s
    const next = new Map(s.mentions)
    next.delete(conversationId)
    return { mentions: next }
  }),
}))

export const easterEggMentionStore = useEasterEggMentionStore
