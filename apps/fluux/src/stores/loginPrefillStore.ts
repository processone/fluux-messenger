import { create } from 'zustand'
import type { LoginPrefill } from '@fluux/sdk'

/**
 * Holds a one-shot login prefill produced by an xmpp: deep link (desktop) or
 * URL query params (web). LoginScreen consumes it to seed its fields, then
 * clears it so it does not bleed across a later logout.
 *
 * App-level UI state (not an SDK store): the prefill only ever touches the
 * login form, never the XMPP connection directly.
 */
interface LoginPrefillState {
  prefill: LoginPrefill | null
  setPrefill: (prefill: LoginPrefill) => void
  clearPrefill: () => void
}

export const useLoginPrefillStore = create<LoginPrefillState>((set) => ({
  prefill: null,
  setPrefill: (prefill) => set({ prefill }),
  clearPrefill: () => set({ prefill: null }),
}))
