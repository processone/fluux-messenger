import { create } from 'zustand'

const STORAGE_KEY = 'fluux-e2ee-plaintext-overrides'

function loadInitial(): Record<string, true> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    const result: Record<string, true> = {}
    for (const [k, v] of Object.entries(parsed)) {
      if (v === true) result[k] = true
    }
    return result
  } catch {
    return {}
  }
}

function persist(jids: Record<string, true>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(jids))
  } catch {
    // localStorage unavailable — in-memory state stays consistent.
  }
}

interface ConversationPlaintextOverrideState {
  plaintextJids: Record<string, true>
  setForcedPlaintext: (jid: string, forced: boolean) => void
  isForcedPlaintext: (jid: string) => boolean
}

export const useConversationPlaintextOverrideStore = create<ConversationPlaintextOverrideState>(
  (set, get) => ({
    plaintextJids: loadInitial(),

    setForcedPlaintext: (jid, forced) => {
      set((s) => {
        const next = { ...s.plaintextJids }
        if (forced) next[jid] = true
        else delete next[jid]
        persist(next)
        return { plaintextJids: next }
      })
    },

    isForcedPlaintext: (jid) => jid in get().plaintextJids,
  }),
)

export function isConversationForcedPlaintext(jid: string): boolean {
  return jid in useConversationPlaintextOverrideStore.getState().plaintextJids
}
