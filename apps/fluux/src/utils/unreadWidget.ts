import { chatStore, connectionStore, roomStore, unreadConversations } from '@fluux/sdk'
import type { UnreadConversation } from '@fluux/sdk'
import { pushBadgeState, sharePushBadge, type PushBadgeState } from './pushBadge'

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
  /** When this state snapshot was built, in milliseconds since the epoch. */
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

// Writes reach native code in order, so a stale list cannot land after a newer one or after a clear.
let writes: Promise<void> = Promise.resolve()
let active: { stop: () => void; cancel: () => void } | undefined
// The account being signed out: nothing is published for it until the app has another one.
let clearedAccount: string | null = null
// Ends the block when the session itself ends, however the publisher was stopped by then.
let releaseBlock: (() => void) | undefined

async function write(list: UnreadWidgetList | null, badge?: PushBadgeState): Promise<void> {
  try {
    // One projection owns membership even when the number of unread conversations is unchanged.
    // The extension also writes both files: native code, not our last call, decides what is current.
    if (badge) await sharePushBadge(badge, { force: true })
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('plugin:widgets|set_unread_list', { list })
  } catch (err) {
    console.warn('[Widgets] Unread list not shared:', err)
  }
}

/** Checks/replaces the actual shared list, or empties it for `null`; native code deduplicates. */
export function shareUnreadWidgetList(list: UnreadWidgetList | null, badge?: PushBadgeState): Promise<void> {
  const next = writes.then(() => write(list, badge))
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
  const account = connectionStore.getState().jid?.split('/')[0] ?? null
  releaseBlock?.()
  clearedAccount = account
  if (account) {
    // The block belongs to this session: once the connection no longer is this account's, signing back in is allowed.
    const unsubscribe = connectionStore.subscribe(() => {
      if (connectionStore.getState().jid?.split('/')[0] === account) return
      clearedAccount = null
      releaseBlock?.()
    })
    releaseBlock = () => { releaseBlock = undefined; unsubscribe() }
  }
  return shareUnreadWidgetList(null, { unread: [], events: 0, notifyAllRooms: [] })
}

/** Resets the publisher, session block and publication queue. For tests. */
export function resetSharedUnreadWidgetList(): void {
  active?.stop()
  writes = Promise.resolve()
  active = undefined
  releaseBlock?.()
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
    const connection = connectionStore.getState()
    const account = connection.jid?.split('/')[0]
    if (account && account === clearedAccount) return
    // A wake is not proof that catch-up has established the current unread state.
    if (account && (connection.status !== 'online' || connection.isVerifying || connection.isCatchingUp || connection.replayOwners > 0)) return
    if (account !== clearedAccount) clearedAccount = null
    const conversations = chatStore.getState().conversations
    const rooms = roomStore.getState()
    const pending = events()
    const now = Date.now()
    const list = account ? unreadWidgetList(account, conversations.values(), rooms, pending, now) : null
    void shareUnreadWidgetList(list,
      account ? { ...pushBadgeState(conversations.values(), rooms, pending), account, updated: now }
        : { unread: [], events: 0, notifyAllRooms: [] })
  }
  const schedule = () => { if (!stopped) timer ??= setTimeout(publish, PUBLISH_DELAY_MS) }
  const unsubscribe = [chatStore.subscribe(schedule), roomStore.subscribe(schedule), connectionStore.subscribe(schedule)]
  const cancel = () => { clearTimeout(timer); timer = undefined }
  // Do not leave a known snapshot waiting on a JS timer when iOS suspends the webview.
  const flushBeforeHide = () => {
    if (document.visibilityState !== 'hidden' || timer === undefined) return
    cancel()
    publish()
  }
  document.addEventListener('visibilitychange', flushBeforeHide)
  const stop = () => {
    stopped = true
    cancel()
    document.removeEventListener('visibilitychange', flushBeforeHide)
    unsubscribe.forEach(unsubscribeOne => unsubscribeOne())
    if (active?.stop === stop) active = undefined
  }
  active?.stop()
  active = { stop, cancel }
  schedule()
  return stop
}
