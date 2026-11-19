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
import { savedStore, findSavedEntry } from '../stores/savedStore'
import { getBareJid } from './jid'
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
  let flushing = false
  let flushAgain = false

  const online = () => connectionStore.getState().status === 'online'

  async function flush(): Promise<void> {
    if (flushing) { flushAgain = true; return }
    flushing = true
    try {
      do {
        flushAgain = false
        if (!online()) return
        const { pending, entries } = savedStore.getState()
        for (const [id, op] of Object.entries(pending)) {
          if (!online()) return
          try {
            if (op === 'publish') {
              const entry = entries[id]
              if (!entry) { savedStore.getState().settle(id, op); continue }
              await client.internal.savedMessages.publish(entry)
            } else {
              await client.internal.savedMessages.retract(id)
            }
            savedStore.getState().settle(id, op)
          } catch (error) {
            // A retract of an absent item is a success; any other definitive answer is a refusal.
            if (isDefinitiveRejection(error)) {
              if (op === 'retract') savedStore.getState().settle(id, op)
              else { logWarn(`SavedMessages: server refused a save: ${String(error)}`); savedStore.getState().refuse(id, op) }
            }
            // Silence or a transport failure: the operation stays pending for the next trigger.
          }
        }
      } while (flushAgain)
      if (savedStore.getState().limit === undefined) {
        savedStore.getState().setLimit(await client.internal.savedMessages.fetchMaxItems())
      }
    } finally {
      flushing = false
    }
  }

  async function refresh(): Promise<void> {
    const jid = getBareJid(connectionStore.getState().jid ?? '')
    if (jid && account && account !== jid) savedStore.getState().reset()
    if (jid) account = jid
    savedStore.getState().hydratePending()
    const result = await client.internal.savedMessages.fetchAll()
    if (result.status === 'ok') savedStore.getState().reconcileFetch(result.items)
    else if (result.status === 'absent') savedStore.getState().reconcileFetch([])
    else logInfo(`SavedMessages: fetch ${result.status}; keeping the current list`)
    savedStore.getState().setLimit(await client.internal.savedMessages.fetchMaxItems())
    await flush()
  }

  const unsubscribeOnline = client.internal.on('online', () => { void refresh().catch(() => {}) })
  const unsubscribeResumed = client.internal.on('resumed', () => { void flush().catch(() => {}) })
  const unsubscribeNotify = client.subscribe('saved:synced', (update) => {
    savedStore.getState().applyNotify(update)
    void flush().catch(() => {})
  })
  const unsubscribeStore = savedStore.subscribe((state, previous) => {
    if (state.pending !== previous.pending && Object.keys(state.pending).length > 0) void flush().catch(() => {})
  })

  // An original that was retracted or moderated: keep the entry, drop its text.
  const deleted = (updates: { isRetracted?: boolean; isModerated?: boolean }) => updates.isRetracted === true || updates.isModerated === true
  const markDeleted = (conversationJid: string, messageId: string) => {
    const { entries } = savedStore.getState()
    const hit = findSavedEntry(entries, { conversationJid, messageId, stanzaId: messageId, stanzaIdBy: undefined })
      ?? Object.values(entries).find((e) => e.conversationJid === conversationJid && (e.messageId === messageId || e.stanzaId === messageId || e.originId === messageId))
    if (hit) savedStore.getState().markDeleted(hit.id)
  }
  const unsubscribeChat = client.subscribe('chat:message-updated', ({ conversationId, messageId, updates }) => {
    if (deleted(updates)) markDeleted(conversationId, messageId)
  })
  const unsubscribeRoom = client.subscribe('room:message-updated', ({ roomJid, messageId, updates }) => {
    if (deleted(updates)) markDeleted(roomJid, messageId)
  })

  return () => {
    unsubscribeOnline(); unsubscribeResumed(); unsubscribeNotify(); unsubscribeStore(); unsubscribeChat(); unsubscribeRoom()
  }
}
