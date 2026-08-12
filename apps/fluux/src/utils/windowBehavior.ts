import { invoke } from '@tauri-apps/api/core'
import { platform } from '@/platform'

export interface TrayStatus {
  enabled: boolean
  available: boolean
}
export function supportsTrayPreference(): boolean {
  return platform().canKeepInSystemTray
}

export async function setKeepInSystemTray(enabled: boolean): Promise<TrayStatus | null> {
  if (!supportsTrayPreference()) return null
  return invoke<TrayStatus>('set_keep_in_tray', { enabled })
}

export async function getTrayStatus(): Promise<TrayStatus | null> {
  if (!supportsTrayPreference()) return null
  return invoke<TrayStatus>('get_tray_status')
}
