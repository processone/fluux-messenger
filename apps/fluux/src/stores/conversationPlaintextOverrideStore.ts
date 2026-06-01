import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

const STORAGE_KEY_BASE = 'fluux-e2ee-plaintext-overrides'

function getScopedKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

function loadFromStorage(): Record<string, true> {
  try {
    const scopedKey = getScopedKey()
    let raw = localStorage.getItem(scopedKey)
    // Migration: copy from base key if scoped key is empty
    if (!raw && scopedKey !== STORAGE_KEY_BASE) {
      const oldRaw = localStorage.getItem(STORAGE_KEY_BASE)
      if (oldRaw) {
        localStorage.setItem(scopedKey, oldRaw)
        localStorage.removeItem(STORAGE_KEY_BASE)
        raw = oldRaw
      }
    }
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
    localStorage.setItem(getScopedKey(), JSON.stringify(jids))
  } catch {
    // localStorage unavailable — in-memory state stays consistent.
  }
}

interface ConversationPlaintextOverrideState {
  plaintextJids: Record<string, true>
  setForcedPlaintext: (jid: string, forced: boolean) => void
  isForcedPlaintext: (jid: string) => boolean
  rehydrate: () => void
}

export const useConversationPlaintextOverrideStore = create<ConversationPlaintextOverrideState>(
  (set, get) => ({
    plaintextJids: loadFromStorage(),

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

    rehydrate: () => set({ plaintextJids: loadFromStorage() }),
  }),
)

export function isConversationForcedPlaintext(jid: string): boolean {
  return jid in useConversationPlaintextOverrideStore.getState().plaintextJids
}

export function rehydratePlaintextOverrides(): void {
  useConversationPlaintextOverrideStore.getState().rehydrate()
}
