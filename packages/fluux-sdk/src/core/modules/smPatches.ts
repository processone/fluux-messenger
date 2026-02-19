/**
 * Stream Management monkey-patches for xmpp.js
 *
 * These patches are applied at runtime to the xmpp.js client instance created
 * in Connection.createXmppClient(). They address two issues:
 *
 * 1. **SM ack debouncing** (patchSmAckDebounce):
 *    xmpp.js sends an immediate <a h='N'/> for every <r/> from the server.
 *    During high-traffic periods (MAM catch-up, room joins), this creates
 *    excessive network traffic. We wrap entity.send() to debounce SM ack
 *    stanzas (250ms window), coalescing multiple <r/> responses into a single
 *    <a/> with the latest h value.
 *
 *    XEP-0198 compliance: The spec says <a/> SHOULD (not MUST) be sent
 *    "as soon as possible". A 250ms debounce is well within server timeout
 *    windows (Prosody: 30s, ejabberd: 60s).
 *
 * 2. **SM ackQueue desync fix** (patchSmAckQueue):
 *    When a page reloads, the outbound queue is lost but the server maintains
 *    its counter. On session resume, ackQueue() tries to shift N items from
 *    an empty queue, causing `item.stanza` to crash on undefined.
 *    See: https://github.com/xmppjs/xmpp.js/pull/1119
 *
 *    We patch outbound_q.shift() to return a sentinel object when empty
 *    (preventing the crash), and patch sm.emit to suppress 'ack' events
 *    for sentinel items.
 *
 * @module
 */

import type { Client, Element } from '@xmpp/client'
import { xml } from '@xmpp/client'

const NS_SM = 'urn:xmpp:sm:3'
const DEBOUNCE_MS = 250

/** State for SM ack debounce — stored per Connection instance */
export interface SmPatchState {
  smAckDebounceTimer: ReturnType<typeof setTimeout> | null
  originalEntitySend: ((stanza: Element) => Promise<void>) | null
}

/** Create initial patch state */
export function createSmPatchState(): SmPatchState {
  return {
    smAckDebounceTimer: null,
    originalEntitySend: null,
  }
}

/**
 * Debounce SM ack responses to reduce traffic during high-volume periods.
 *
 * Wraps entity.send() to intercept `<a xmlns="urn:xmpp:sm:3" h="N"/>` stanzas
 * and debounce them. When the timer fires, it sends a fresh ack with the latest
 * sm.inbound value (which may have advanced since the original <r/>).
 *
 * Guard: only patches real xmpp.js clients — test mocks (which lack outbound_q)
 * are left untouched.
 */
export function patchSmAckDebounce(state: SmPatchState, xmppClient: Client): void {
  const sm = xmppClient.streamManagement as any
  // Guard: only patch real xmpp.js clients (not test mocks which lack outbound_q)
  if (!Array.isArray(sm?.outbound_q)) return

  state.originalEntitySend = xmppClient.send.bind(xmppClient)
  const originalSend = state.originalEntitySend

  xmppClient.send = ((stanza: Element): Promise<void> => {
    // Only debounce SM ack stanzas: <a xmlns="urn:xmpp:sm:3" h="N"/>
    if (stanza.name === 'a' && stanza.attrs?.xmlns === NS_SM) {
      if (state.smAckDebounceTimer) {
        clearTimeout(state.smAckDebounceTimer)
      }
      return new Promise<void>((resolve) => {
        state.smAckDebounceTimer = setTimeout(() => {
          state.smAckDebounceTimer = null
          // Send with latest h value (sm.inbound may have advanced since the <r/>)
          const freshAck = xml('a', { xmlns: NS_SM, h: String(sm.inbound) })
          originalSend(freshAck).then(resolve, resolve)
        }, DEBOUNCE_MS)
      })
    }
    // All other stanzas pass through immediately
    return originalSend(stanza)
  }) as Client['send']
}

/**
 * Fix SM ackQueue crash after page reload (xmppjs/xmpp.js#1119).
 *
 * Patches outbound_q.shift() to return a sentinel `{ stanza: null }` when the
 * queue is empty (preventing crash in ackQueue's `item.stanza` access).
 *
 * Also patches sm.emit to suppress 'ack' events for sentinel items, and uses
 * Object.defineProperty to re-patch whenever xmpp.js reassigns outbound_q
 * (e.g., `sm.outbound_q = []` in resumed()).
 */
export function patchSmAckQueue(sm: any): void {
  if (!Array.isArray(sm.outbound_q) || typeof sm.emit !== 'function') return

  // Sentinel: has .stanza property to prevent crash in ackQueue's `item.stanza`
  const SENTINEL = { stanza: null }

  // Patch shift on the current outbound_q array
  const patchQueueShift = (q: any[]) => {
    const nativeShift = Array.prototype.shift
    q.shift = function() {
      if (this.length === 0) return SENTINEL
      return nativeShift.call(this)
    }
  }
  patchQueueShift(sm.outbound_q)

  // xmpp.js replaces outbound_q (e.g., sm.outbound_q = [] in resumed()),
  // so re-patch whenever it's reassigned
  let currentQ = sm.outbound_q
  Object.defineProperty(sm, 'outbound_q', {
    get: () => currentQ,
    set: (val: any[]) => {
      currentQ = val
      if (Array.isArray(val)) patchQueueShift(val)
    },
    configurable: true,
  })

  // Suppress 'ack' events for sentinel items (stanza === null)
  const originalEmit = sm.emit.bind(sm)
  sm.emit = function(event: string, ...args: any[]) {
    if (event === 'ack' && args[0] === null) return false
    return originalEmit(event, ...args)
  }
}

/**
 * Flush any pending debounced SM ack immediately before disconnect.
 * Sends the final <a/> with the latest h value using the original send.
 */
export function flushSmAckDebounce(state: SmPatchState, xmppClient: Client): void {
  if (state.smAckDebounceTimer) {
    clearTimeout(state.smAckDebounceTimer)
    state.smAckDebounceTimer = null
    if (state.originalEntitySend) {
      const sm = xmppClient.streamManagement as any
      if (sm?.enabled) {
        const freshAck = xml('a', { xmlns: NS_SM, h: String(sm.inbound) })
        state.originalEntitySend(freshAck).catch(() => {})
      }
    }
  }
  state.originalEntitySend = null
}

/**
 * Clear SM ack debounce timer without sending (e.g., dead socket).
 */
export function clearSmAckDebounce(state: SmPatchState): void {
  if (state.smAckDebounceTimer) {
    clearTimeout(state.smAckDebounceTimer)
    state.smAckDebounceTimer = null
  }
  state.originalEntitySend = null
}
