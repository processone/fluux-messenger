import { create } from 'zustand'
import { useCallback } from 'react'

/**
 * Cross-platform "an update is available" state.
 *
 * Two mutually-exclusive channels feed one rail affordance:
 *  - **web** (`webUpdateReady`): a new PWA service worker is waiting to activate.
 *    Applying it reloads the page into the new build.
 *  - **desktop** (`desktopUpdateAvailable`): the Tauri updater found a release.
 *    Applying it reopens the in-app UpdateModal.
 *
 * A build only ever exposes one channel (web registers a service worker but has
 * no Tauri updater; desktop has the updater but registers no service worker), so
 * the two booleans are never both true in practice — `activateUpdate` still
 * prioritizes web defensively.
 *
 * The action closures are registered by their platform owners
 * (`registerServiceWorker` for web, `App` for desktop) rather than living here,
 * so this store stays free of platform imports.
 */
export interface AppUpdateState {
  webUpdateReady: boolean
  desktopUpdateAvailable: boolean
  applyWebUpdate: (() => void) | null
  openDesktopUpdate: (() => void) | null
  /** Mark (or clear) a waiting web update, registering the reload action. */
  setWebUpdateReady: (ready: boolean, apply?: (() => void) | null) => void
  /** Mark (or clear) an available desktop update, registering the open action. */
  setDesktopUpdateAvailable: (available: boolean, open?: (() => void) | null) => void
}

export const useAppUpdateStore = create<AppUpdateState>((set) => ({
  webUpdateReady: false,
  desktopUpdateAvailable: false,
  applyWebUpdate: null,
  openDesktopUpdate: null,
  setWebUpdateReady: (ready, apply = null) =>
    set({ webUpdateReady: ready, applyWebUpdate: ready ? apply : null }),
  setDesktopUpdateAvailable: (available, open = null) =>
    set({ desktopUpdateAvailable: available, openDesktopUpdate: available ? open : null }),
}))

/**
 * Run the platform-appropriate update action. Web takes priority over desktop
 * (they are mutually exclusive by build, but web wins if both ever signal).
 * Pure over the passed state so it is trivially unit-testable.
 */
export function activateUpdate(
  state: Pick<AppUpdateState, 'webUpdateReady' | 'desktopUpdateAvailable' | 'applyWebUpdate' | 'openDesktopUpdate'>,
): void {
  if (state.webUpdateReady) state.applyWebUpdate?.()
  else if (state.desktopUpdateAvailable) state.openDesktopUpdate?.()
}

/**
 * The single affordance the rail button consumes: whether to show, and what to
 * do on click. Subscribes only to the two booleans; the action closures are
 * read lazily at click time so registering them never re-renders the button.
 */
export function useUpdateAffordance(): { visible: boolean; activate: () => void } {
  const webUpdateReady = useAppUpdateStore((s) => s.webUpdateReady)
  const desktopUpdateAvailable = useAppUpdateStore((s) => s.desktopUpdateAvailable)
  const activate = useCallback(() => activateUpdate(useAppUpdateStore.getState()), [])
  return { visible: webUpdateReady || desktopUpdateAvailable, activate }
}
