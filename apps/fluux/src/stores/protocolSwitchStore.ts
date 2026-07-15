import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

const KEY = 'fluux-e2ee-protocol-switch'
type Persisted = { last: Record<string, string>; pending: Record<string, boolean> }

export function load(): Persisted {
  try {
    const parsed = JSON.parse(localStorage.getItem(buildScopedStorageKey(KEY)) || '')
    if (
      parsed && typeof parsed === 'object'
      && parsed.last && typeof parsed.last === 'object'
      && parsed.pending && typeof parsed.pending === 'object'
    ) {
      return parsed as Persisted
    }
    return { last: {}, pending: {} }
  } catch {
    return { last: {}, pending: {} }
  }
}
function save(p: Persisted): void {
  try { localStorage.setItem(buildScopedStorageKey(KEY), JSON.stringify(p)) } catch { /* ignore */ }
}

interface State {
  last: Record<string, string>
  pending: Record<string, boolean>
  recordSelected: (peer: string, protocolId: string) => { switchedFromOpenpgp: boolean }
  pendingNotice: (peer: string) => boolean
  dismiss: (peer: string) => void
  reset: () => void
}

export const useProtocolSwitchStore = create<State>((set, get) => ({
  ...load(),
  recordSelected: (peer, protocolId) => {
    const prev = get().last[peer]
    const switched = prev === 'openpgp' && protocolId === 'omemo:2'
    const last = { ...get().last, [peer]: protocolId }
    const pending = switched ? { ...get().pending, [peer]: true } : get().pending
    const next = { last, pending }
    save(next); set(next)
    return { switchedFromOpenpgp: switched }
  },
  pendingNotice: (peer) => !!get().pending[peer],
  dismiss: (peer) => {
    const pending = { ...get().pending }; delete pending[peer]
    const next = { last: get().last, pending }
    save(next); set(next)
  },
  reset: () => { const next = { last: {}, pending: {} }; save(next); set(next) },
}))
