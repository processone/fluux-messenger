import { type ReactNode } from 'react'
import { useTheme } from '@/hooks/useTheme'
import { useAppearanceSync } from '@/hooks/useAppearanceSync'
import { useDensity } from '@/hooks/useDensity'

interface ThemeProviderProps {
  children: ReactNode
}

/**
 * Initializes theme on mount and applies theme variables + mode class to document.
 * Also handles PEP sync when connected (via useAppearanceSync).
 * Applies the display-density attribute to the document root (via useDensity).
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  useTheme()
  useAppearanceSync()
  useDensity()
  return <>{children}</>
}
