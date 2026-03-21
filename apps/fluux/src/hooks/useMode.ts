import { useTheme } from './useTheme'

/**
 * @deprecated Use `useTheme` directly. This wrapper exists for backward compatibility.
 *
 * Returns:
 * - mode: The current mode setting ('light' | 'dark' | 'system')
 * - setMode: Function to change the mode
 * - resolvedMode: The actual applied mode ('light' | 'dark')
 * - isDark: Convenience boolean for dark mode checks
 */
export function useMode() {
  const { mode, setMode, resolvedMode, isDark } = useTheme()
  return { mode, setMode, resolvedMode, isDark }
}
