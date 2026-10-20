import { create } from 'zustand'
const key = (account: string) => `fluux-ios-ox-previews:${account}`
/** Why previews could not be enabled, as shown under the setting. */
export type PreviewProblem = 'credential' | 'refused' | 'key' | 'server' | 'unavailable'
export interface PreviewFailure {
  problem: PreviewProblem
  /** The native error of an `unavailable` failure, for a bug report; it carries no secret. */
  detail?: string
}
interface Settings {
  account: string | null
  enabled: boolean
  /** Previews are on but the extension has no FAST token and no usable password to obtain one. */
  missingCredential: boolean
  /** Why the latest provisioning attempt failed, whether the user or the app started it. */
  failure: PreviewFailure | null
  setAccount: (account: string | null) => void
  setEnabled: (enabled: boolean) => void
  setMissingCredential: (missing: boolean) => void
  setFailure: (failure: PreviewFailure | null) => void
}
export const useIOSPreviewSettingsStore = create<Settings>((set, get) => ({
  account: null, enabled: false, missingCredential: false, failure: null,
  setAccount: (account) => {
    // On unless the user turned previews off for this account; they still need OpenPGP enabled.
    let enabled = !!account
    try { enabled = !!account && localStorage.getItem(key(account)) !== '0' } catch { /* default on */ }
    set({ account, enabled, missingCredential: false, failure: null })
  },
  setEnabled: (enabled) => {
    const account = get().account
    if (!account) return
    try { localStorage.setItem(key(account), enabled ? '1' : '0') } catch { /* session preference */ }
    set({ enabled })
  },
  setMissingCredential: (missingCredential) => set({ missingCredential }),
  setFailure: (failure) => set({ failure }),
}))
