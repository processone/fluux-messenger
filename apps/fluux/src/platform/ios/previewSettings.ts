import { create } from 'zustand'
const key = (account: string) => `fluux-ios-ox-previews:${account}`
interface Settings {
  account: string | null
  enabled: boolean
  /** Previews are on but no saved password lets the extension sign in to fetch messages. */
  missingCredential: boolean
  setAccount: (account: string | null) => void
  setEnabled: (enabled: boolean) => void
  setMissingCredential: (missing: boolean) => void
}
export const useIOSPreviewSettingsStore = create<Settings>((set, get) => ({
  account: null, enabled: false, missingCredential: false,
  setAccount: (account) => {
    let enabled = false
    try { enabled = !!account && localStorage.getItem(key(account)) === '1' } catch { /* default off */ }
    set({ account, enabled, missingCredential: false })
  },
  setEnabled: (enabled) => {
    const account = get().account
    if (!account) return
    try { localStorage.setItem(key(account), enabled ? '1' : '0') } catch { /* session preference */ }
    set({ enabled })
  },
  setMissingCredential: (missingCredential) => set({ missingCredential }),
}))
