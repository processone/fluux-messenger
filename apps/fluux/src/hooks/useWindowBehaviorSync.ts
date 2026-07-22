import { useEffect } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { setKeepInSystemTray, supportsTrayPreference } from '@/utils/windowBehavior'

/** Keep Rust window-event policy in sync with the persisted frontend setting. */
export function useWindowBehaviorSync(): void {
  const keepInSystemTray = useSettingsStore((state) => state.keepInSystemTray)

  useEffect(() => {
    if (!supportsTrayPreference()) return
    void setKeepInSystemTray(keepInSystemTray).catch((error) => {
      console.error('[WindowBehavior] Failed to synchronize tray preference:', error)
    })
  }, [keepInSystemTray])
}
