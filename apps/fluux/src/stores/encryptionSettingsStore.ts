import { create } from 'zustand'

/**
 * User preference for end-to-end encryption, scoped to the entire
 * application (not per-conversation — that lives in the SDK's strategy
 * pins when/if we expose per-conversation UI).
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
}

const OPENPGP_ENABLED_KEY = 'fluux-e2ee-openpgp-enabled'

function getInitialOpenpgpEnabled(): boolean {
  try {
    return localStorage.getItem(OPENPGP_ENABLED_KEY) === '1'
  } catch {
    return false
  }
}

export const useEncryptionSettingsStore = create<EncryptionSettingsState>((set) => ({
  openpgpEnabled: getInitialOpenpgpEnabled(),
  setOpenpgpEnabled: (enabled) => {
    try {
      localStorage.setItem(OPENPGP_ENABLED_KEY, enabled ? '1' : '0')
    } catch {
      // localStorage unavailable — still update in-memory state so the
      // rest of the session behaves consistently.
    }
    set({ openpgpEnabled: enabled })
  },
  pluginRegisteredAt: 0,
  notifyPluginRegistered: () => set((s) => ({ pluginRegisteredAt: s.pluginRegisteredAt + 1 })),
}))

/**
 * Imperative read — for non-React code paths like `registerE2EEPlugins`
 * that run on the `online` event and need the current preference without
 * subscribing.
 */
export function isOpenpgpEnabled(): boolean {
  return useEncryptionSettingsStore.getState().openpgpEnabled
}
