import { invoke } from '@tauri-apps/api/core'
import { isLinux, isTauri, isWindows } from './tauri'

export interface TrayStatus {
  enabled: boolean
  available: boolean
}
export function supportsTrayPreference(): boolean {
  return isTauri() && (isWindows() || isLinux())
}

export async function setKeepInSystemTray(enabled: boolean): Promise<TrayStatus | null> {
  if (!supportsTrayPreference()) return null
  return invoke<TrayStatus>('set_keep_in_tray', { enabled })
}

export async function getTrayStatus(): Promise<TrayStatus | null> {
  if (!supportsTrayPreference()) return null
  return invoke<TrayStatus>('get_tray_status')
}
