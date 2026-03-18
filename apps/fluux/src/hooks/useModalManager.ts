/**
 * useModalManager - Centralized modal state management
 *
 * Consolidates modal state into a single hook with:
 * - Unified open/close/toggle actions
 * - Escape hierarchy for keyboard navigation
 * - Helper to close the topmost open modal
 */

import { useState, useRef } from 'react'

/**
 * Modal names in escape priority order (highest priority first).
 * When Escape is pressed, the first open modal in this list is closed.
 */
export type ModalName =
  | 'commandPalette'
  | 'shortcutHelp'
  | 'presenceMenu'
  | 'quickChat'
  | 'addContact'

/**
 * State for all managed modals
 */
export interface ModalState {
  commandPalette: boolean
  shortcutHelp: boolean
  presenceMenu: boolean
  quickChat: boolean
  addContact: boolean
}

/**
 * Actions to manipulate modal state
 */
export interface ModalActions {
  /** Open a specific modal */
  open: (modal: ModalName) => void
  /** Close a specific modal */
  close: (modal: ModalName) => void
  /** Toggle a specific modal */
  toggle: (modal: ModalName) => void
  /** Close all modals at once */
  closeAll: () => void
  /** Close the topmost open modal (highest priority). Returns true if a modal was closed. */
  closeTopmost: () => boolean
}

export interface UseModalManagerReturn {
  /** Current state of all modals */
  state: ModalState
  /** Actions to manipulate modals */
  actions: ModalActions
  /** True if any modal is currently open */
  isAnyOpen: boolean
  /** Get the close handler for the topmost open modal, or null if none open */
  getEscapeHandler: () => (() => void) | null
}

/** Initial state with all modals closed */
const initialState: ModalState = {
  commandPalette: false,
  shortcutHelp: false,
  presenceMenu: false,
  quickChat: false,
  addContact: false,
}

/** Escape priority order - first open modal in this list gets closed on Escape */
const ESCAPE_PRIORITY: ModalName[] = [
  'commandPalette',
  'shortcutHelp',
  'presenceMenu',
  'quickChat',
  'addContact',
]

export function useModalManager(): UseModalManagerReturn {
  const [state, setState] = useState<ModalState>(initialState)

  // Use a ref to track current state for stable callback functions.
  // This allows closeTopmost and getEscapeHandler to read current state
  // without needing state in their dependency arrays (which would cause
  // actions to be recreated on every state change → render loops).
  const stateRef = useRef<ModalState>(state)
  stateRef.current = state

  const open = (modal: ModalName) => {
    setState(prev => ({ ...prev, [modal]: true }))
  }

  const close = (modal: ModalName) => {
    setState(prev => ({ ...prev, [modal]: false }))
  }

  const toggle = (modal: ModalName) => {
    setState(prev => ({ ...prev, [modal]: !prev[modal] }))
  }

  const closeAll = () => {
    setState(initialState)
  }

  // Read from ref to avoid depending on state (which changes on every modal change)
  const closeTopmost = () => {
    const currentState = stateRef.current
    for (const modal of ESCAPE_PRIORITY) {
      if (currentState[modal]) {
        close(modal)
        return true
      }
    }
    return false
  }

  const isAnyOpen = Object.values(state).some(Boolean)

  // Read from ref to avoid depending on state
  const getEscapeHandler = () => {
    const currentState = stateRef.current
    for (const modal of ESCAPE_PRIORITY) {
      if (currentState[modal]) {
        return () => close(modal)
      }
    }
    return null
  }

  const actions: ModalActions = { open, close, toggle, closeAll, closeTopmost }

  return {
    state,
    actions,
    isAnyOpen,
    getEscapeHandler,
  }
}
