import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

/**
 * User preference for end-to-end encryption, scoped per account.
 *
 * E2EE is currently **opt-in and off by default** because:
 * - OpenPGP plugin is experimental (RustCrypto backend, no signature
 *   verification, no passphrase protection on the secret key, no
 *   persistence across app restarts).
 * - First-time users should not silently have a key generated and
 *   published to their server without consent.
 *
 * When the user flips this flag on, the app registers the OpenPGP plugin
 * (desktop only) on the next `online` event or immediately if already
 * online. Flipping it off unregisters the plugin; the Rust-side key stays
 * in memory so a subsequent re-enable reuses the same fingerprint within
 * the same process.
 */
interface EncryptionSettingsState {
  openpgpEnabled: boolean
  setOpenpgpEnabled: (enabled: boolean) => void
  /**
   * Incremented each time a plugin finishes registering. Used as a reactive
   * dependency in `useConversationEncryptionState` so the probe effect
   * re-runs reliably after async plugin init — avoiding the race between
   * `status === 'online'` and `registerE2EEPlugins` completing.
   */
  pluginRegisteredAt: number
  notifyPluginRegistered: () => void
  rehydrate: () => void
}

const STORAGE_KEY_BASE = 'fluux-e2ee-openpgp-enabled'

function getScopedKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

function loadOpenpgpEnabled(): boolean {
  try {
    const scopedKey = getScopedKey()
    let raw = localStorage.getItem(scopedKey)
    // Migration: copy from base key if scoped key is empty
    if (raw === null && scopedKey !== STORAGE_KEY_BASE) {
      const legacy = localStorage.getItem(STORAGE_KEY_BASE)
      if (legacy !== null) {
        localStorage.setItem(scopedKey, legacy)
        localStorage.removeItem(STORAGE_KEY_BASE)
        raw = legacy
      }
    }
    return raw === '1'
  } catch {
    return false
  }
}

export const useEncryptionSettingsStore = create<EncryptionSettingsState>((set) => ({
  openpgpEnabled: loadOpenpgpEnabled(),
  setOpenpgpEnabled: (enabled) => {
    try {
      localStorage.setItem(getScopedKey(), enabled ? '1' : '0')
    } catch {
      // localStorage unavailable — still update in-memory state so the
      // rest of the session behaves consistently.
    }
    set({ openpgpEnabled: enabled })
  },
  pluginRegisteredAt: 0,
  notifyPluginRegistered: () => set((s) => ({ pluginRegisteredAt: s.pluginRegisteredAt + 1 })),
  rehydrate: () => set({ openpgpEnabled: loadOpenpgpEnabled() }),
}))

/**
 * Imperative read — for non-React code paths like `registerE2EEPlugins`
 * that run on the `online` event and need the current preference without
 * subscribing.
 */
export function isOpenpgpEnabled(): boolean {
  return useEncryptionSettingsStore.getState().openpgpEnabled
}

export function rehydrateEncryptionSettings(): void {
  useEncryptionSettingsStore.getState().rehydrate()
}
