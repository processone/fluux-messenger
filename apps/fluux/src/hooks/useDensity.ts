import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

/**
 * Applies the current density preference to the document root as a
 * `data-density` attribute, so CSS keyed on `[data-density="compact"]` adjusts
 * spacing app-wide with no React re-render of list rows.
 */
export function useDensity(): void {
  const densityMode = useSettingsStore((s) => s.densityMode)
  useEffect(() => {
    document.documentElement.setAttribute('data-density', densityMode)
  }, [densityMode])
}
