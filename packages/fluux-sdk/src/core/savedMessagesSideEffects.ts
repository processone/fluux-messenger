/**
 * Saved messages sync side effect (docs/XEP-SAVED_MESSAGES.md).
 *
 * The saved store applies saves and removals at once and keeps them pending.
 * This sends them to the private node, fetches the node on every fresh
 * session, applies `+notify` pushes from the account's other clients, and
 * clears the text of an entry whose original was deleted.
 *
 * Only an answered fetch replaces the list. A refused or unanswered fetch
 * leaves it alone.
 *
 * @module Core/SavedMessagesSideEffects
 */

import type { SideEffectHost } from './sideEffectHost'
import type { SideEffectsOptions } from './chatSideEffects'
import { connectionStore } from '../stores/connectionStore'
import { savedStore } from '../stores/savedStore'
import { getBareJid } from './jid'
import { isItemNotFoundError } from '../hooks/shared/mamCursor'
import { logInfo, logWarn } from './logger'

/** A definitive server answer, as opposed to silence or a transport failure. */
function isDefinitiveRejection(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'StanzaError'
}

export function setupSavedMessagesSideEffects(
  client: SideEffectHost,
  _options: SideEffectsOptions = {},
): () => void {
  let account: string | undefined
  // Bumped when the account changes or the effects are torn down: work started
  // under an older epoch must not touch the store or send anything afterwards.
  let epoch = 0
  let flushing = false
  let flushAgain = false
  let refreshing = false

  const online = () => connectionStore.getState().status === 'online'
  const state = () => savedStore.getState()

  /** Items the server holds: everything not waiting to be added (a republished deletion is already there). */
  const serverCount = () => {
    const { entries, pending } = state()
    return Object.values(entries).filter((entry) => pending[entry.id] !== 'publish' || entry.deleted).length
  }

  const switchAccount = () => {
    epoch += 1
    flushing = false
    flushAgain = false
    state().reset()
  }

  async function flush(): Promise<void> {
    if (flushing) { flushAgain = true; return }
    const mine = epoch
    const current = () => mine === epoch && online()
    flushing = true
    try {
      do {
        flushAgain = false
        // Nothing is sent before the node's contents are known: a publish into a
        // full node silently evicts the oldest saved message.
        if (!current() || !state().loaded) return
        // Removals first: they free the room new saves need.
        const queue = Object.entries(state().pending).sort(([, a], [, b]) => Number(b === 'retract') - Number(a === 'retract'))
        for (const [id, op] of queue) {
          if (!current()) return
          const revision = state().revisions[id]
          try {
            if (op === 'publish') {
              const entry = state().entries[id]
              if (!entry) { state().settle(id, op, revision); continue }
              const { limit } = state()
              if (limit !== undefined && !entry.deleted && serverCount() >= limit) {
                state().refuse(id, op, revision)
                continue
              }
              await client.internal.savedMessages.publish(entry)
            } else {
              await client.internal.savedMessages.retract(id)
            }
            if (mine === epoch) state().settle(id, op, revision)
          } catch (error) {
            if (mine !== epoch) return
            if (!isDefinitiveRejection(error)) continue // silence: the operation stays pending
            if (op === 'retract' && isItemNotFoundError(error)) state().settle(id, op, revision) // already gone
            else {
              logWarn(`SavedMessages: server refused a ${op}: ${String(error)}`)
              state().refuse(id, op, revision)
              if (op === 'retract') void refresh().catch(() => {}) // the item is still there: list it again
            }
          }
        }
      } while (flushAgain)
      if (mine === epoch && state().limit === undefined) {
        const limit = await client.internal.savedMessages.fetchMaxItems()
        if (mine === epoch) state().setLimit(limit)
      }
    } finally {
      if (mine === epoch) flushing = false
    }
  }

  async function refresh(): Promise<void> {
    const jid = getBareJid(connectionStore.getState().jid ?? '')
    if (jid && account && account !== jid) switchAccount()
    if (jid) account = jid
    state().hydratePending()
    const mine = epoch
    // Changes that arrive while the fetch is in flight are newer than its answer.
    const before = state().entries
    refreshing = true
    try {
      const result = await client.internal.savedMessages.fetchAll()
      if (mine !== epoch) return
      const limit = await client.internal.savedMessages.fetchMaxItems()
      if (mine !== epoch) return
      // The limit is set before the list lands: landing it triggers a flush that must see it.
      state().setLimit(limit ?? state().limit)
      if (result.status === 'ok' || result.status === 'absent') {
        const now = state().entries
        const changed = new Set<string>()
        for (const id of new Set([...Object.keys(before), ...Object.keys(now)])) if (before[id] !== now[id]) changed.add(id)
        state().reconcileFetch(result.status === 'ok' ? result.items : [], changed)
      } else logInfo(`SavedMessages: fetch ${result.status}; keeping the current list`)
    } finally {
      refreshing = false
    }
    await flush()
  }

  const unsubscribeOnline = client.internal.on('online', () => { void refresh().catch(() => {}) })
  // A resumed session keeps the stream but not this page's memory: with no list loaded, read it.
  const unsubscribeResumed = client.internal.on('resumed', () => {
    void (state().loaded && !refreshing ? flush() : refresh()).catch(() => {})
  })
  const unsubscribeNotify = client.subscribe('saved:synced', (update) => {
    state().applyNotify(update)
    void flush().catch(() => {})
  })
  // Another account signing in must never see or send the previous account's list.
  const unsubscribeAccount = connectionStore.subscribe((next) => {
    const jid = getBareJid(next.jid ?? '')
    if (jid && account && account !== jid) { switchAccount(); account = jid }
  })
  const unsubscribeStore = savedStore.subscribe((next, previous) => {
    if (next.pending !== previous.pending && Object.keys(next.pending).length > 0) void flush().catch(() => {})
  })

  return () => {
    epoch += 1
    flushing = false
    unsubscribeOnline(); unsubscribeResumed(); unsubscribeNotify(); unsubscribeAccount(); unsubscribeStore()
  }
}
