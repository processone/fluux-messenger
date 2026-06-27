import { create } from 'zustand'

/**
 * Advanced mode — an opt-in flag that unlocks advanced/expert surfaces
 * throughout the app (e.g. the XMPP console, the "Advanced" settings category).
 *
 * It is toggled by a kebab menu on the login screen. The Advanced settings
 * category (always visible) also provides a toggle to turn it on or off at
 * any time.
 *
 * Persisted to localStorage, mirroring the pattern used by settingsStore.
 */

const ADVANCED_MODE_KEY = 'fluux-advanced-mode'

function getInitialAdvancedMode(): boolean {
  try {
    return localStorage.getItem(ADVANCED_MODE_KEY) === 'true'
  } catch {
    // localStorage not available
    return false
  }
}

interface AdvancedModeState {
  advancedMode: boolean
  setAdvancedMode: (enabled: boolean) => void
  toggleAdvancedMode: () => void
}

export const useAdvancedModeStore = create<AdvancedModeState>((set, get) => ({
  advancedMode: getInitialAdvancedMode(),

  setAdvancedMode: (enabled) => {
    try {
      localStorage.setItem(ADVANCED_MODE_KEY, enabled ? 'true' : 'false')
    } catch {
      // localStorage not available
    }
    set({ advancedMode: enabled })
  },

  toggleAdvancedMode: () => get().setAdvancedMode(!get().advancedMode),
}))

/**
 * Non-reactive read of the advanced-mode flag, for use outside React render
 * (e.g. {@link getVisibleCategories}). Components that need to re-render on
 * change should subscribe via `useAdvancedModeStore` instead.
 */
export function isAdvancedMode(): boolean {
  return useAdvancedModeStore.getState().advancedMode
}
