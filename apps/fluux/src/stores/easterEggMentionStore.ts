import { create } from 'zustand'

export interface PendingEasterEgg {
  id: string
  conversationId: string
  animation: string
  senderName: string
  played: boolean
}

interface EasterEggMentionState {
  mentions: Map<string, PendingEasterEgg>
  add: (egg: Omit<PendingEasterEgg, 'played'>) => void
  markPlayed: (conversationId: string) => void
  dismiss: (conversationId: string) => void
}

export const useEasterEggMentionStore = create<EasterEggMentionState>((set) => ({
  mentions: new Map(),
  // Latest egg wins: one pending egg per conversation. A new egg resets
  // `played` to false so it auto-plays once again.
  add: (egg) => set((s) => {
    const next = new Map(s.mentions)
    next.set(egg.conversationId, { ...egg, played: false })
    return { mentions: next }
  }),
  markPlayed: (conversationId) => set((s) => {
    const entry = s.mentions.get(conversationId)
    if (!entry) return s
    const next = new Map(s.mentions)
    next.set(conversationId, { ...entry, played: true })
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
