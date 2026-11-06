import { connectionStore, roomStore, rosterStore, chatStore } from '@fluux/sdk'
import { platform } from '@/platform'
import { shortcutConversations } from '@/utils/shortcutConversation'
import { observeWidgetSupport, widgetSessionSupported, type WidgetWriteResult } from './widgetSupport'

/** Display names by bare JID, which title the pushes their sender sends. */
export interface PushSenderNames {
  contacts: Record<string, string>
  rooms: Record<string, string>
}

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

function supportsMirror(): boolean {
  return (platform().usesNativePush && platform().os === 'ios') ||
    (platform().publishesUnreadWidget && platform().os === 'macos' && widgetSessionSupported())
}

function mirrorCommand(command: string): string {
  return `plugin:${platform().os === 'macos' ? 'widgets' : 'push'}|${command}`
}

const WRITE_DELAY_MS = 1000
const MAX_SOURCE_BYTES = 2 * 1024 * 1024

async function avatarBytes(url: string, signal: AbortSignal): Promise<ArrayBuffer | null> {
  const response = await fetch(url, { signal })
  const blob = await response.blob()
  if (blob.size > MAX_SOURCE_BYTES) return null
  return blob.arrayBuffer()
}

// Wipes and image writes remain ordered across session hook remounts.
let writeQueue = Promise.resolve()
let stopActive: (() => void) | undefined

export async function clearAppleConversationMirror(): Promise<void> {
  if (!supportsMirror()) return
  stopActive?.()
  // Native input writes are serialized before suggestion deletion; a stalled
  // system callback must not keep the signed-in account visible to the extension.
  const pending = writeQueue
  const revoke = async () => {
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<WidgetWriteResult | undefined>(mirrorCommand('set_sender_names'), { names: { account: null, contacts: {}, rooms: {}, avatars: {} } })
    if (platform().os === 'macos') observeWidgetSupport(result)
  }
  const wipe = revoke()
  // Preserve prompt revocation even when a system acknowledgement stalls, then wipe again
  // after every in-flight write and the first wipe. A new session queues behind that barrier.
  writeQueue = Promise.all([pending, wipe.catch(() => {})]).then(revoke).catch(() => {})
  await wipe
}

/** Starts the Apple shared-conversation mirror for iOS notifications or the macOS widget. */
export function startAppleConversationMirror(): () => void {
  if (!supportsMirror()) return () => {}

  let account = connectionStore.getState().jid?.split('/')[0] ?? null
  let generation = 0
  let stopped = false
  let shared: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const sent = new Set<string>()
  let reads = new AbortController()

  const invoke = async (command: string, args: Record<string, unknown>, isCurrent?: () => boolean) => {
    const { invoke: nativeInvoke } = await import('@tauri-apps/api/core')
    if (isCurrent && !isCurrent()) return undefined
    const result = await nativeInvoke<WidgetWriteResult | undefined>(command, args)
    if (platform().os === 'macos' && !observeWidgetSupport(result)) stopActive?.()
    return result
  }
  const enqueue = (work: () => Promise<void>) => {
    writeQueue = writeQueue.then(work).catch((err) => console.warn('[NativePush] Notification mirror not shared:', err))
  }

  const write = async () => {
    if (stopped || !account) return
    if (!supportsMirror()) { stop(); return }
    const version = generation
    const owner = account
    const roster = rosterStore.getState()
    const ownsRoster = roster.isLoaded && roster.accountJid === owner
    const contacts = ownsRoster ? [...roster.contacts.values()] : []
    const rooms = ownsRoster ? [...roomStore.getState().rooms.values()] : []
    const names = pushSenderNames(contacts, rooms)
    const roomParticipants: Record<string, { ownNick: string; nicks: string[] }> = {}
    for (const room of rooms) {
      if (!names.rooms[room.jid] || !room.joined || !room.occupants.has(room.nickname)) continue
      roomParticipants[room.jid] = { ownNick: room.nickname, nicks: [...room.occupants.keys()].sort() }
    }
    const conversations = ownsRoster
      ? shortcutConversations(owner, chatStore.getState().conversations.values(), rooms)
      : []
    const entries = [...contacts, ...rooms].filter(entity =>
      entity.avatar?.startsWith('blob:') || entity.avatar?.startsWith('data:image/'))
    const preserveIfEmpty = !ownsRoster
    const signature = JSON.stringify({
      owner, names, roomParticipants, conversations, preserveIfEmpty,
      sources: entries.map(({ jid, avatarHash, avatar }) => [jid, avatarHash, avatar]),
    })
    if (signature === shared) return
    const current = () => !stopped && version === generation && owner === account &&
      (!ownsRoster || (rosterStore.getState().accountJid === owner && rosterStore.getState().isLoaded))
    const sources = new Map<string, string>()
    const avatars: Record<string, string> = {}
    for (const entity of entries) {
      const url = entity.avatar!
      if (url.startsWith('blob:') && entity.avatarHash && /^[a-f0-9]{40}$/i.test(entity.avatarHash)) {
        const hash = entity.avatarHash.toLowerCase()
        sources.set(hash, url)
        avatars[entity.jid] = hash
      } else {
        try {
          const bytes = await avatarBytes(url, reads.signal)
          if (!current()) return
          if (!bytes) continue
          const digest = await crypto.subtle.digest('SHA-1', bytes)
          if (!current()) return
          const hash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
          sources.set(hash, url)
          avatars[entity.jid] = hash
        } catch {
          if (!current()) return
        }
      }
    }
    // Establish account ownership before sending any bytes. Native code wipes a previous account.
    await invoke(mirrorCommand('set_sender_names'), {
      names: { ...names, account: owner, avatars, conversations,
        ...(Object.keys(roomParticipants).length ? { roomParticipants } : {}),
        ...(preserveIfEmpty ? { preserveIfEmpty: true } : {}) },
    }, current)
    if (!current()) return
    for (const [hash, url] of sources) {
      if (!current()) return
      if (sent.has(hash)) continue
      try {
        const buffer = await avatarBytes(url, reads.signal)
        if (!buffer) continue
        const bytes = new Uint8Array(buffer)
        if (!current()) return
        let binary = ''
        for (const byte of bytes) binary += String.fromCharCode(byte)
        const result = await invoke(mirrorCommand('set_notification_avatar'), {
          avatar: { account: owner, hash, data: btoa(binary) },
        }, current)
        if (!current()) return
        if (result?.written) sent.add(hash)
      } catch {
        // A missing or undecodable cache entry leaves the notification without an image.
      }
    }
    if (!current()) return
    for (const hash of sent) if (!sources.has(hash)) sent.delete(hash)
    shared = signature
  }

  const schedule = () => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      enqueue(write)
    }, WRITE_DELAY_MS)
  }
  const unsubscribeConnection = connectionStore.subscribe(() => {
    const next = connectionStore.getState().jid?.split('/')[0] ?? null
    if (next === account) return
    account = next
    generation++
    shared = null
    sent.clear()
    clearTimeout(timer)
    timer = undefined
    // Queue the wipe immediately, even if React unmounts this hook during logout.
    reads.abort()
    reads = new AbortController()
    enqueue(async () => {
      await invoke(mirrorCommand('set_sender_names'), {
        names: { account: null, contacts: {}, rooms: {}, avatars: {} },
      })
    })
    if (account) schedule()
  })
  const unsubscribeRoster = rosterStore.subscribe(schedule)
  const unsubscribeRooms = roomStore.subscribe(schedule)
  const unsubscribeChats = chatStore.subscribe(schedule)
  schedule()

  const stop = () => {
    stopped = true
    reads.abort()
    generation++
    clearTimeout(timer)
    unsubscribeConnection()
    unsubscribeRoster()
    unsubscribeRooms()
    unsubscribeChats()
    if (stopActive === stop) stopActive = undefined
  }
  stopActive = stop
  return stop
}
