import { create } from 'zustand'

export interface ReactionMention {
  id: string
  conversationId: string
  messageId: string
  reactorName: string
  emoji: string
  preview: string
}

interface ReactionMentionState {
  mentions: Map<string, ReactionMention[]>
  addMention: (m: ReactionMention) => void
  dismissMention: (conversationId: string, id: string) => void
  clearConversation: (conversationId: string) => void
}

export const useReactionMentionStore = create<ReactionMentionState>((set) => ({
  mentions: new Map(),
  addMention: (m) => set((s) => {
    const next = new Map(s.mentions)
    const list = (next.get(m.conversationId) ?? []).filter((x) => x.id !== m.id)
    next.set(m.conversationId, [...list, m])
    return { mentions: next }
  }),
  dismissMention: (conversationId, id) => set((s) => {
    const next = new Map(s.mentions)
    const list = (next.get(conversationId) ?? []).filter((x) => x.id !== id)
    if (list.length) next.set(conversationId, list); else next.delete(conversationId)
    return { mentions: next }
  }),
  clearConversation: (conversationId) => set((s) => {
    if (!s.mentions.has(conversationId)) return s
    const next = new Map(s.mentions)
    next.delete(conversationId)
    return { mentions: next }
  }),
}))

export const reactionMentionStore = useReactionMentionStore
