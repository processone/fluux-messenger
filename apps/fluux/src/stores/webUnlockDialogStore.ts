import { create } from 'zustand'

/**
 * Cross-component control for the {@link UnlockEncryptionDialog} mount.
 *
 * The dialog is rendered once at the App root and any component (chat
 * header lock icon, encrypted-message placeholder, settings page) can
 * open it by calling `openWebUnlockDialog()`. Keeping the open flag in a
 * zustand store avoids prop-drilling a setter through the component tree
 * and prevents duplicate dialog mounts.
 */
interface WebUnlockDialogState {
  isOpen: boolean
  openWebUnlockDialog: () => void
  closeWebUnlockDialog: () => void
}

export const useWebUnlockDialogStore = create<WebUnlockDialogState>((set) => ({
  isOpen: false,
  openWebUnlockDialog: () => set({ isOpen: true }),
  closeWebUnlockDialog: () => set({ isOpen: false }),
}))

/**
 * Imperative open — for non-React code paths (e.g. connect-time auto
 * detection in App.tsx) that need to surface the dialog without going
 * through a hook.
 */
export function openWebUnlockDialog(): void {
  useWebUnlockDialogStore.getState().openWebUnlockDialog()
}
