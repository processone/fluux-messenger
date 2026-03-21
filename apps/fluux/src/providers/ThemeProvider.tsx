import { type ReactNode } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { useAppearanceSync } from '@/hooks/useAppearanceSync'

interface ThemeProviderProps {
  children: ReactNode
}

/**
 * Initializes theme on mount and applies theme variables + mode class to document.
 * Also handles PEP sync when connected (via useAppearanceSync).
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  useTheme()
  useAppearanceSync()
  return <>{children}</>
}
