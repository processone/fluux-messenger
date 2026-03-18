/**
 * LayoutContext - Provides shared layout state to avoid prop drilling
 *
 * Currently exposes:
 * - Modal management via useModalManager
 *
 * Components can use specialized hooks:
 * - useModals() - access modal state and actions
 */

import { createContext, useContext, type ReactNode } from 'react'
import { useModalManager, type UseModalManagerReturn } from '@/hooks/useModalManager'

/**
 * Context value containing all shared layout state
 */
export interface LayoutContextValue {
  /** Modal management (command palette, shortcuts help, quick chat, etc.) */
  modals: UseModalManagerReturn
}

const LayoutContext = createContext<LayoutContextValue | null>(null)

/**
 * Provider component that wraps the layout and provides shared state
 */
export function LayoutProvider({ children }: { children: ReactNode }) {
  const modals = useModalManager()

  const value: LayoutContextValue = { modals }

  return (
    <LayoutContext.Provider value={value}>
      {children}
    </LayoutContext.Provider>
  )
}

/**
 * Hook to access the full layout context
 * @throws Error if used outside of LayoutProvider
 */
export function useLayout(): LayoutContextValue {
  const context = useContext(LayoutContext)
  if (!context) {
    throw new Error('useLayout must be used within a LayoutProvider')
  }
  return context
}

/**
 * Hook to access only modal state and actions
 * Use this in components that only need modal functionality
 */
export function useModals(): UseModalManagerReturn {
  return useLayout().modals
}
