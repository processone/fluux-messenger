import { useSettingsStore } from '@/stores/settingsStore'

/**
 * True when operating-system notifications must not play their own sound.
 *
 * The OS can play its own alert independently of the in-app sound hooks, so
 * foreground delivery reads the preference at posting time. Background Web
 * Push reads the worker-accessible copy through pushSoundPreference instead.
 */
export function osNotificationSilent(): boolean {
  return !useSettingsStore.getState().soundEnabled
}
