import { create } from 'zustand'
import { connectionStore } from '@fluux/sdk'
import { useSettingsStore } from '@/stores/settingsStore'
import { platform } from '@/platform'

export const iosNotificationTones = ['default', 'bell', 'chime', 'pulse', 'silent'] as const
export type IOSNotificationTone = typeof iosNotificationTones[number]
const key = (account: string) => `fluux-ios-notification-tone:${account}`
interface SoundState {
  account: string | null
  tone: IOSNotificationTone
  setAccount: (account: string | null) => void
  setTone: (tone: IOSNotificationTone) => void
}
export const useIOSSoundSettingsStore = create<SoundState>((set, get) => ({
  account: null, tone: 'default',
  setAccount: account => {
    let tone: IOSNotificationTone = 'default'
    try {
      const saved = account ? localStorage.getItem(key(account)) : null
      if (iosNotificationTones.includes(saved as IOSNotificationTone)) tone = saved as IOSNotificationTone
    } catch { /* use the system default */ }
    set({ account, tone })
  },
  setTone: tone => {
    const account = get().account
    if (!account || !iosNotificationTones.includes(tone)) return
    try { localStorage.setItem(key(account), tone) } catch { /* session preference */ }
    set({ tone })
  },
}))

let queue = Promise.resolve()
/** Mirrors only sound preferences; notification preview settings have their own owner. */
export function startIOSNotificationSounds(): () => void {
  if (!platform().usesNativePush || platform().os !== 'ios') return () => {}
  let stopped = false
  let signature = ''
  const write = () => {
    const state = useIOSSoundSettingsStore.getState()
    const settings = { account: state.account, tone: state.tone, enabled: useSettingsStore.getState().soundEnabled }
    const next = JSON.stringify(settings)
    if (next === signature) return
    signature = next
    queue = queue.then(async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      // Wipes remain queued across logout/unmount; stale nonempty writes are discarded.
      if (settings.account && (stopped || connectionStore.getState().jid?.split('/')[0] !== settings.account)) return
      await invoke('plugin:push|set_notification_sound', { settings })
    }).catch(() => { signature = '' })
  }
  const changeAccount = () => {
    const account = connectionStore.getState().jid?.split('/')[0] ?? null
    if (account !== useIOSSoundSettingsStore.getState().account) {
      useIOSSoundSettingsStore.getState().setAccount(null)
      if (account) useIOSSoundSettingsStore.getState().setAccount(account)
    }
    write()
  }
  const offSettings = useSettingsStore.subscribe(write)
  const offTone = useIOSSoundSettingsStore.subscribe(write)
  const offConnection = connectionStore.subscribe(changeAccount)
  changeAccount()
  return () => { stopped = true; offSettings(); offTone(); offConnection() }
}
