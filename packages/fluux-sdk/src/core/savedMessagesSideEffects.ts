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
import { cachedDeletions } from '../utils/savedLatestCopy'
import type { SavedMessage } from './types/saved'
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

  /** Items the server is known to hold, including ones this device has asked to remove but not yet seen go. */
  const serverCount = () => Object.keys(state().remote).length

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
        // A node that exists but whose limit is unknown (the read failed): try again before adding anything to it.
        if (state().limit === undefined && serverCount() > 0) {
          const limit = await client.internal.savedMessages.fetchMaxItems().catch(() => undefined)
          if (mine !== epoch) return
          state().setLimit(limit)
        }
        const queue = Object.entries(state().pending).sort(([, a], [, b]) => Number(b === 'retract') - Number(a === 'retract'))
        let created = false
        for (const [id, op] of queue) {
          if (!current()) return
          if (state().pending[id] !== op) continue // settled, replaced or wiped meanwhile
          const revision = state().revisions[id]
          // A wipe resets revisions, so a revision alone cannot tell this operation from a later one of the same id.
          const generation = state().generation
          const sameStore = () => mine === epoch && generation === state().generation
          try {
            if (op === 'publish') {
              const entry = state().entries[id]
              if (!entry) { state().settle(id, op, revision); continue }
              const { limit } = state()
              if (!state().remote[id]) {
                if (limit !== undefined && serverCount() >= limit) {
                  state().refuse(id, op, revision)
                  continue
                }
                // Limit unknown: only the first item of a node that does not exist yet may go (it creates the node);
                // anything else waits until the limit can be read.
                if (limit === undefined && (created || serverCount() > 0)) continue
              }
              // Only a first item of a node that does not exist yet asks for the node's limit.
              const create = limit === undefined && !state().remote[id]
              try {
                await client.internal.savedMessages.publish(entry, { create })
              } catch (error) {
                // A server that enforces publish-option preconditions refuses the limit on a node that exists with another one:
                // repeat once with the privacy constraints alone, and only while this operation is still the current one.
                if (!create || !isDefinitiveRejection(error) || !current() || !sameStore() || state().pending[id] !== op || state().revisions[id] !== revision) throw error
                await client.internal.savedMessages.publish(entry, { create: false })
              }
              created = true
            } else {
              await client.internal.savedMessages.retract(id)
            }
            if (!sameStore()) return
            // The server took it, whatever this device has queued since: membership counts it either way.
            state().confirm(id, op)
            state().settle(id, op, revision)
            // The first publish creates the node, and only then can its limit be read: later saves wait for it.
            if (op === 'publish' && state().limit === undefined) {
              const limit = await client.internal.savedMessages.fetchMaxItems().catch(() => undefined)
              if (!sameStore()) return
              state().setLimit(limit)
            }
          } catch (error) {
            if (!sameStore()) return
            if (!isDefinitiveRejection(error)) continue // silence: the operation stays pending
            if (op === 'retract' && isItemNotFoundError(error)) { state().confirm(id, op); state().settle(id, op, revision) } // already gone
            else {
              logWarn(`SavedMessages: server refused a ${op}: ${String(error)}`)
              state().refuse(id, op, revision)
              if (op === 'retract' && !state().entries[id]) void refresh().catch(() => {}) // nothing to restore locally: read the node again
            }
          }
        }
      } while (flushAgain)
      if (mine === epoch && state().limit === undefined) {
        const limit = await client.internal.savedMessages.fetchMaxItems().catch(() => undefined)
        if (mine === epoch) state().setLimit(limit)
      }
    } finally {
      if (mine === epoch) {
        flushing = false
        // Work that left early (stale after a wipe, or interrupted) must not swallow a flush requested meanwhile
        // for the current store: it is dispatched now instead of waiting for an unrelated trigger.
        if (flushAgain) { flushAgain = false; void flush() }
      }
    }
  }

  async function refresh(): Promise<void> {
    const jid = getBareJid(connectionStore.getState().jid ?? '')
    if (jid && account && account !== jid) switchAccount()
    if (jid) account = jid
    state().hydratePending()
    const mine = epoch
    // Changes that arrive while this read is in flight are newer than its answer; the read owns its own record of them.
    const read = state().beginFetch()
    refreshing = true
    try {
      const result = await client.internal.savedMessages.fetchAll()
      if (mine !== epoch || !state().fetchCurrent(read)) return
      const limit = await client.internal.savedMessages.fetchMaxItems().catch(() => undefined)
      if (mine !== epoch || !state().fetchCurrent(read)) return
      if (result.status === 'ok' || result.status === 'absent') {
        const items = result.status === 'ok' ? result.items : []
        // What the cache already knows is deleted loses its text, whatever the retraction ledger still holds.
        const deleted = await cachedDeletions([...items, ...Object.values(state().entries)], connectionStore.getState().jid ?? '').catch(() => new Set<string>())
        if (mine !== epoch || !state().fetchCurrent(read)) return
        // The limit is set before the list lands: landing it triggers a flush that must see it.
        state().setLimit(limit ?? state().limit)
        state().reconcileFetch(items, read, deleted)
      } else {
        state().setLimit(limit ?? state().limit)
        logInfo(`SavedMessages: fetch ${result.status}; keeping the current list`)
      }
    } finally {
      refreshing = false
      state().endFetch(read) // a read that did not land leaves nothing behind
    }
    await flush()
  }

  const unsubscribeOnline = client.internal.on('online', () => { void refresh().catch(() => {}) })
  // A resumed session keeps the stream but not this page's memory: with no list loaded, read it.
  const unsubscribeResumed = client.internal.on('resumed', () => {
    void (state().loaded && !refreshing ? flush() : refresh()).catch(() => {})
  })
  // Notifications apply in arrival order, after what the cache knows of deletions has been learned.
  let notifications: Promise<void> = Promise.resolve()
  const unsubscribeNotify = client.subscribe('saved:synced', (update) => {
    const mine = epoch
    const generation = state().generation
    notifications = notifications.then(async () => {
      const upserts: SavedMessage[] = update.upserts
      const deleted = await cachedDeletions(upserts, connectionStore.getState().jid ?? '').catch(() => new Set<string>())
      // A wipe or an account change while the cache was read means this update is not wanted any more.
      if (mine !== epoch || generation !== state().generation) return
      state().applyNotify(update, deleted)
      await flush()
    }).catch(() => {})
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
