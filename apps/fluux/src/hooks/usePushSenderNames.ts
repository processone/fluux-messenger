import { useEffect } from 'react'
import { roomStore, rosterStore } from '@fluux/sdk'
import { platform } from '@/platform'

/** Display names by bare JID, which title the pushes their sender sends. */
export interface PushSenderNames {
  contacts: Record<string, string>
  rooms: Record<string, string>
}

const WRITE_DELAY_MS = 1000

function namesByJid(entries: Iterable<{ jid: string; name: string }>): Record<string, string> {
  const names: Record<string, string> = {}
  for (const { jid, name } of entries) {
    if (name.trim()) names[jid] = name
  }
  return names
}

export function pushSenderNames(
  contacts: Iterable<{ jid: string; name: string }>,
  rooms: Iterable<{ jid: string; name: string }>,
): PushSenderNames {
  return { contacts: namesByJid(contacts), rooms: namesByJid(rooms) }
}

async function shareSenderNames(names: PushSenderNames): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('plugin:push|set_sender_names', { names })
}

/**
 * Shares contact and room names with the iOS notification service extension,
 * which cannot read the app's storage, so pushes show who sent them.
 *
 * Presence and messages change the stores far more often than names do, so
 * changes are batched and a write happens only when a name changed.
 * The empty stores of a launch do not overwrite the names of the last session.
 */
export function usePushSenderNames(): void {
  useEffect(() => {
    if (!platform().usesNativePush) return

    let shared: string | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const write = () => {
      const names = pushSenderNames(
        rosterStore.getState().contacts.values(),
        roomStore.getState().rooms.values(),
      )
      const serialized = JSON.stringify(names)
      if (serialized === shared) return
      const empty = Object.keys(names.contacts).length === 0 && Object.keys(names.rooms).length === 0
      if (shared === null && empty) return
      shared = serialized
      shareSenderNames(names).catch((err) => console.warn('[NativePush] Sender names not shared:', err))
    }

    const schedule = () => {
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        write()
      }, WRITE_DELAY_MS)
    }

    const unsubscribeRoster = rosterStore.subscribe(schedule)
    const unsubscribeRooms = roomStore.subscribe(schedule)
    schedule()

    return () => {
      clearTimeout(timer)
      unsubscribeRoster()
      unsubscribeRooms()
    }
  }, [])
}
