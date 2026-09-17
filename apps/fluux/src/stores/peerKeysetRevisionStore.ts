import { create } from 'zustand'

interface PeerKeysetRevisionState {
  revisionByJid: Record<string, number>
  notifyPeerKeysetChanged: (jid: string) => void
}

export const usePeerKeysetRevisionStore = create<PeerKeysetRevisionState>((set) => ({
  revisionByJid: {},
  notifyPeerKeysetChanged: (jid) => set((state) => ({
    revisionByJid: {
      ...state.revisionByJid,
      [jid]: (state.revisionByJid[jid] ?? 0) + 1,
    },
  })),
}))

export function notifyPeerKeysetChanged(jid: string): void {
  usePeerKeysetRevisionStore.getState().notifyPeerKeysetChanged(jid)
}
