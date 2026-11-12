import { chatStore, connectionStore, roomStore, unreadConversations } from '@fluux/sdk'
import type { UnreadConversation } from '@fluux/sdk'
import { platform } from '@/platform'
import { observeWidgetSupport, resetWidgetSupportForTesting, widgetSessionSupported, type WidgetWriteResult } from '@/platform/apple/widgetSupport'
import { pushBadgeState, sharePushBadge, type PushBadgeState } from './pushBadge'
import { observeWidgetBadge, resetWidgetPublisherDiagnostic, widgetPublisherDiagnostic } from './unreadWidgetDiagnostic'

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
// The desktop writer owns its file; only iOS has extension-side membership mutations.
let shared: string | null = null
let writes: Promise<void> = Promise.resolve()
let active: { stop: () => void; cancel: () => void } | undefined
// The account being signed out: nothing is published for it until the app has another one.
let clearedAccount: string | null = null
// Ends the block when the session itself ends, however the publisher was stopped by then.
let releaseBlock: (() => void) | undefined

async function write(list: UnreadWidgetList | null, refresh = false, badge?: PushBadgeState): Promise<void> {
  if (!widgetSessionSupported()) return
  const desktop = platform().os === 'macos'
  const serialized = JSON.stringify(list && { ...list, updated: 0 })
  const initial = list !== null && (shared === null || shared === 'null')
  const renew = refresh || (initial && desktop && platform().publishesUnreadWidget)
  // Desktop retains its session cache and heartbeat; iOS rechecks extension-writable files.
  if (desktop && !renew && serialized === shared) return
  if (desktop) shared = serialized
  try {
    // One projection owns membership even when the number of unread conversations is unchanged.
    // The extension also writes both files: native code, not our last call, decides what is current.
    if (badge) await sharePushBadge(badge, { force: true, observe: observeWidgetBadge(list?.account ?? null) })
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<WidgetWriteResult | undefined>('plugin:widgets|set_unread_list', {
      list, ...(renew ? { heartbeat: true } : {}),
    })
    if (!observeWidgetSupport(result)) active?.stop()
  } catch (err) {
    if (desktop) shared = null
    console.warn('[Widgets] Unread list not shared:', err)
  }
}

/** Rechecks the iOS file; desktop retains its session deduplication and refresh policy. */
export function shareUnreadWidgetList(list: UnreadWidgetList | null, refresh = false, badge?: PushBadgeState): Promise<void> {
  const next = writes.then(() => write(list, refresh, badge))
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
  resetWidgetPublisherDiagnostic()
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
  return shareUnreadWidgetList(null, false, platform().usesNativePush ? { unread: [], events: 0, notifyAllRooms: [] } : undefined)
}

/** Resets the publisher, session block and publication queue. For tests. */
export function resetSharedUnreadWidgetList(): void {
  active?.stop()
  resetWidgetSupportForTesting()
  shared = null
  writes = Promise.resolve()
  active = undefined
  releaseBlock?.()
  clearedAccount = null
  resetWidgetPublisherDiagnostic()
}

/** Only fixed states leave this module; no account or conversation identity is exported. */
export function unreadWidgetDiagnosticContext() {
  const connection = connectionStore.getState()
  const owner = connection.jid?.split('/')[0] ?? null
  return widgetPublisherDiagnostic({
    active: !!active && !(owner && owner === clearedAccount), owner,
    online: typeof connection.status === 'string' ? connection.status === 'online' : null,
    verifying: typeof connection.isVerifying === 'boolean' ? connection.isVerifying : null,
    catchingUp: typeof connection.isCatchingUp === 'boolean' ? connection.isCatchingUp : null,
    replaying: typeof connection.replayOwners === 'number' ? connection.replayOwners > 0 : null,
  })
}

const PUBLISH_DELAY_MS = 500
// Desktop policy uses a fifteen-minute heartbeat; the shared stale window adds five minutes of grace.
export const DESKTOP_WIDGET_HEARTBEAT_MS = 15 * 60_000

/**
 * Keeps the widget's list current while the app runs. Returns a function that
 * stops it. `events` reads the pending-event count the badge adds.
 */
export function startUnreadWidgetPublisher(events: () => number, heartbeatMs?: number): () => void {
  if (!widgetSessionSupported()) return () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const publish = (refresh = false) => {
    clearTimeout(timer)
    timer = undefined
    if (stopped) return
    if (!widgetSessionSupported()) { stop(); return }
    const connection = connectionStore.getState()
    const account = connection.jid?.split('/')[0]
    if (account && account === clearedAccount) return
    // Wait for the session to be online, verified and not replaying: those take seconds. Archive catch-up is not
    // waited for: it can take minutes, and until the app writes, the icon shows the number the notification
    // extension saved, which can already be read elsewhere. Catch-up changes publish again as they land.
    if (platform().usesNativePush && account && (connection.status !== 'online' || connection.isVerifying || connection.replayOwners > 0)) return
    if (account !== clearedAccount) clearedAccount = null
    const conversations = chatStore.getState().conversations
    const rooms = roomStore.getState()
    const pending = events()
    const now = Date.now()
    const list = account ? unreadWidgetList(account, conversations.values(), rooms, pending, now) : null
    const badge = platform().usesNativePush
      ? account ? { ...pushBadgeState(conversations.values(), rooms, pending), account, updated: now }
        : { unread: [], events: 0, notifyAllRooms: [] }
      : undefined
    void shareUnreadWidgetList(list, refresh, badge)
  }
  const schedule = () => { if (!stopped) timer ??= setTimeout(() => publish(), PUBLISH_DELAY_MS) }
  let diagnosticOwner = connectionStore.getState().jid?.split('/')[0] ?? null
  const unsubscribe = [chatStore.subscribe(schedule), roomStore.subscribe(schedule), connectionStore.subscribe(() => {
    const owner = connectionStore.getState().jid?.split('/')[0] ?? null
    if (owner !== diagnosticOwner) { resetWidgetPublisherDiagnostic(); diagnosticOwner = owner }
    schedule()
  })]
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const heartbeat = heartbeatMs ? setInterval(() => publish(true), heartbeatMs) : undefined
  // Do not leave a known snapshot waiting on a JS timer when iOS suspends the webview.
  const flushBeforeHide = () => {
    if (!platform().usesNativePush || document.visibilityState !== 'hidden' || timer === undefined) return
    cancel()
    publish()
  }
  document.addEventListener('visibilitychange', flushBeforeHide)
  const stop = () => {
    clearInterval(heartbeat)
    stopped = true
    cancel()
    document.removeEventListener('visibilitychange', flushBeforeHide)
    unsubscribe.forEach(unsubscribeOne => unsubscribeOne())
    if (active?.stop === stop) { active = undefined; resetWidgetPublisherDiagnostic() }
  }
  active?.stop()
  active = { stop, cancel }
  schedule()
  return stop
}
