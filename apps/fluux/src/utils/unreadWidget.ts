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

/** Writes the list for the widget, or empties it for `null`, unless unchanged. */
export async function shareUnreadWidgetList(list: UnreadWidgetList | null): Promise<void> {
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

/** Forgets what was last shared, so the next list is sent. For tests. */
export function resetSharedUnreadWidgetList(): void {
  shared = null
}

const PUBLISH_DELAY_MS = 500

/**
 * Keeps the widget's list current while the app runs. Returns a function that
 * stops it. `events` reads the pending-event count the badge adds.
 */
export function startUnreadWidgetPublisher(events: () => number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    timer = undefined
    const account = connectionStore.getState().jid?.split('/')[0]
    void shareUnreadWidgetList(account
      ? unreadWidgetList(account, chatStore.getState().conversations.values(), roomStore.getState(), events())
      : null)
  }
  const schedule = () => { timer ??= setTimeout(publish, PUBLISH_DELAY_MS) }
  const unsubscribe = [chatStore.subscribe(schedule), roomStore.subscribe(schedule), connectionStore.subscribe(schedule)]
  schedule()
  return () => {
    clearTimeout(timer)
    unsubscribe.forEach(stop => stop())
  }
}
