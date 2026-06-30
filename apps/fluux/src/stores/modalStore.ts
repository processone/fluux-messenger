import { create } from 'zustand'
import { dismissAllTooltips } from '../utils/tooltipBus'

/**
 * App-level modal state.
 *
 * Replaces the former LayoutContext/useModalManager pair. A Zustand store gives
 * each consumer a FINE-GRAINED subscription via selectors: a component that reads
 * only `quickChat` does not re-render when `commandPalette` toggles, and a
 * component that reads only the actions never re-renders on state change at all.
 * That is the whole point — opening one modal must not re-render the sidebar
 * column (see docs/2026-06-24-render-perf-phase0-baseline.md, toggleModal row).
 *
 * Actions are stable store methods, so `useModalStore((s) => s.open)` is a
 * forever-stable reference (no useCallback / context value churn).
 */
export type ModalName =
  | 'commandPalette'
  | 'shortcutHelp'
  | 'presenceMenu'
  | 'quickChat'
  | 'addContact'
  | 'joinRoom'
  | 'newMessage'

/**
 * Escape priority order (highest first). On Escape, the first open modal in this
 * list is closed by `closeTopmost`.
 */
export const MODAL_ESCAPE_PRIORITY: ModalName[] = [
  'commandPalette',
  'shortcutHelp',
  'presenceMenu',
  'quickChat',
  'newMessage',
  'addContact',
  'joinRoom',
]

interface ModalStoreState {
  commandPalette: boolean
  shortcutHelp: boolean
  presenceMenu: boolean
  quickChat: boolean
  newMessage: boolean
  addContact: boolean
  joinRoom: boolean
  /** Open a specific modal. */
  open: (modal: ModalName) => void
  /** Close a specific modal. */
  close: (modal: ModalName) => void
  /** Toggle a specific modal. */
  toggle: (modal: ModalName) => void
  /** Close all modals at once. */
  closeAll: () => void
  /** Close the topmost (highest-priority) open modal. Returns true if one closed. */
  closeTopmost: () => boolean
}

const ALL_CLOSED = {
  commandPalette: false,
  shortcutHelp: false,
  presenceMenu: false,
  quickChat: false,
  newMessage: false,
  addContact: false,
  joinRoom: false,
} as const

export const useModalStore = create<ModalStoreState>((set, get) => ({
  ...ALL_CLOSED,
  open: (modal) => {
    // A modal floats above the UI, but hover tooltips portal even higher and
    // are never dismissed by a keyboard-opened modal — clear them on open so
    // none linger over the command palette etc.
    dismissAllTooltips()
    set({ [modal]: true } as Pick<ModalStoreState, ModalName>)
  },
  close: (modal) => set({ [modal]: false } as Pick<ModalStoreState, ModalName>),
  toggle: (modal) =>
    set((s) => {
      if (!s[modal]) dismissAllTooltips()
      return { [modal]: !s[modal] } as Pick<ModalStoreState, ModalName>
    }),
  closeAll: () => set({ ...ALL_CLOSED }),
  closeTopmost: () => {
    const s = get()
    for (const modal of MODAL_ESCAPE_PRIORITY) {
      if (s[modal]) {
        set({ [modal]: false } as Pick<ModalStoreState, ModalName>)
        return true
      }
    }
    return false
  },
}))
