import { chatStore, connectionStore, roomStore, unreadConversations } from '@fluux/sdk'
import type { UnreadConversation } from '@fluux/sdk'

/**
 * What the home-screen widget shows, written into the shared App Group folder.
 *
 * No message text: a row holds the conversation's name, counts and time, so the
 * file reveals no more than the app icon badge and the conversation list names.
 * The rows are the conversations the app icon badge counts and `total` equals
 * the badge, including pending events, which get no row.
 */
export interface UnreadWidgetList {
  /** Bare JID of the signed-in account; the widget's links name it. */
  account: string
  total: number
  rows: UnreadWidgetRow[]
  /** When the app wrote the list, in milliseconds since the epoch. */
  updated: number
}

export interface UnreadWidgetRow {
  id: string
  kind: 'chat' | 'groupchat'
  name: string
  unread: number
  mentions: number
  /** Time of the latest message in milliseconds since the epoch; 0 when unknown. */
  last: number
}

/** Rows the largest widget can show, with a few to spare; the list stays small. */
const MAX_ROWS = 12

export function unreadWidgetList(
  account: string,
  conversations: Parameters<typeof unreadConversations>[0],
  rooms: Parameters<typeof unreadConversations>[1],
  events: number,
  now = Date.now(),
): UnreadWidgetList {
  const all = unreadConversations(conversations, rooms)
  return {
    account,
    total: all.length + events,
    rows: all.slice(0, MAX_ROWS).map(toRow),
    updated: now,
  }
}

function toRow(row: UnreadConversation): UnreadWidgetRow {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    unread: row.unreadCount,
    mentions: row.mentionsCount,
    last: row.lastActivity,
  }
}

let shared: string | null = null
// Writes reach native code in order, so a stale list cannot land after a newer one or after a clear.
let writes: Promise<void> = Promise.resolve()
let active: { stop: () => void; cancel: () => void } | undefined
// The account being signed out: nothing is published for it until the app has another one.
let clearedAccount: string | null = null

async function write(list: UnreadWidgetList | null): Promise<void> {
  // `updated` moves on every build; only the content decides whether to write.
  const serialized = JSON.stringify(list && { ...list, updated: 0 })
  if (serialized === shared) return
  shared = serialized
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:widgets|set_unread_list', { list })
  } catch (err) {
    shared = null
    console.warn('[Widgets] Unread list not shared:', err)
  }
}

/** Writes the list for the widget, or empties it for `null`, unless unchanged. */
export function shareUnreadWidgetList(list: UnreadWidgetList | null): Promise<void> {
  const next = writes.then(() => write(list))
  writes = next
  return next
}

/**
 * Empties the widget's list: drops the publisher's pending publication and
 * keeps it silent for this account, so nothing can bring the account back while
 * the sign-out is still running. Another account is published as usual.
 */
export function clearUnreadWidgetList(): Promise<void> {
  active?.cancel()
  clearedAccount = connectionStore.getState().jid?.split('/')[0] ?? null
  return shareUnreadWidgetList(null)
}

/** Forgets what was last shared, so the next list is sent. For tests. */
export function resetSharedUnreadWidgetList(): void {
  shared = null
  writes = Promise.resolve()
  active = undefined
  clearedAccount = null
}

const PUBLISH_DELAY_MS = 500

/**
 * Keeps the widget's list current while the app runs. Returns a function that
 * stops it. `events` reads the pending-event count the badge adds.
 */
export function startUnreadWidgetPublisher(events: () => number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const publish = () => {
    timer = undefined
    if (stopped) return
    const account = connectionStore.getState().jid?.split('/')[0]
    if (account && account === clearedAccount) return
    if (account !== clearedAccount) clearedAccount = null
    void shareUnreadWidgetList(account
      ? unreadWidgetList(account, chatStore.getState().conversations.values(), roomStore.getState(), events())
      : null)
  }
  const schedule = () => { if (!stopped) timer ??= setTimeout(publish, PUBLISH_DELAY_MS) }
  const unsubscribe = [chatStore.subscribe(schedule), roomStore.subscribe(schedule), connectionStore.subscribe(schedule)]
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const stop = () => {
    stopped = true
    cancel()
    unsubscribe.forEach(unsubscribeOne => unsubscribeOne())
    if (active?.stop === stop) active = undefined
  }
  active?.stop()
  active = { stop, cancel }
  schedule()
  return stop
}
