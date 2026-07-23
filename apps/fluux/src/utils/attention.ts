import { connectionStore } from '@fluux/sdk'
import { isTauri, isWindows } from './tauri'

/** Request persistent Windows taskbar attention for an unfocused Fluux window. */
export function requestAttention(): void {
  if (!isTauri() || !isWindows() || connectionStore.getState().windowVisible) return

  void import('@tauri-apps/api/window')
    .then(({ getCurrentWindow, UserAttentionType }) =>
      getCurrentWindow().requestUserAttention(UserAttentionType.Critical),
    )
    .catch(() => {
      // Attention is a best-effort ambient cue; notification delivery continues.
    })
}
