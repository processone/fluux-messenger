import { platform } from '@/platform'
/** Feedback is optional and cannot change the result of an accepted action. */
export function iosHaptic(kind: 'contextMenu' | 'selection'): void {
  if (!platform().nativeHaptics) return
  void import('@tauri-apps/api/core').then(({ invoke }) => {
    if (platform().nativeHaptics) return invoke('plugin:ios-feedback|haptic', { kind })
  }).catch(() => {})
}
