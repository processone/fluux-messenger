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
 * 2. **SM ackQueue crash defense** (patchSmAckQueue):
 *    xmpp.js's ackQueue() at stream-management/index.js:90-97 reads
 *    `sm.outbound_q.shift().stanza` without a null check. If the server
 *    reports a higher `h` than we've tracked locally (possible on SM resume
 *    after a page reload if our persisted outbound count is slightly behind
 *    what the server received), the unconditional .stanza access throws.
 *    Upstream fix: https://github.com/xmppjs/xmpp.js/pull/1119 (still OPEN
 *    as of @xmpp/stream-management 0.14.0 — we are on the latest release).
 *
 *    Primary defense is now in smPersistence.getState + Connection.hydrate-
 *    StreamManagement, which persist + restore `sm.outbound` so the loop
 *    runs 0 iterations in the common case. This patch stays as defense-in-
 *    depth for rare races (stanzas sent between beforeunload and socket
 *    close, legacy storage formats slipping through validation, etc.).
 *
 *    Mechanics: shift() returns a sentinel `{ stanza: null }` on empty so
 *    ackQueue survives the .stanza read; sm.emit suppresses the phantom
 *    'ack' and 'fail' events. failQueue() uses `while (shift())` and needs
 *    to exit eventually, so `allowEmptySentinel` flips on the first
 *    synthetic 'fail' emit and the next empty shift returns `undefined`.
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
 * Defense-in-depth against xmpp.js ackQueue crash (xmppjs/xmpp.js#1119).
 *
 * The primary fix is hydration: Connection.hydrateStreamManagement restores
 * `sm.outbound` from persisted state so ackQueue's loop runs 0 iterations on
 * the expected `<resumed h=N/>`. This patch exists only for races where the
 * persisted count briefly trails the server's count (e.g. stanzas sent after
 * beforeunload fires).
 *
 * Patches outbound_q.shift() to return a sentinel `{ stanza: null }` when the
 * queue is empty (preventing crash in ackQueue's `item.stanza` access).
 *
 * Also patches sm.emit to suppress sentinel-derived events, and uses
 * Object.defineProperty to re-patch whenever xmpp.js reassigns outbound_q
 * (e.g., `sm.outbound_q = []` in resumed()).
 */
export function patchSmAckQueue(sm: any): void {
  if (!Array.isArray(sm.outbound_q) || typeof sm.emit !== 'function') return

  // Sentinel: has .stanza property to prevent crash in ackQueue's `item.stanza`
  const SENTINEL = { stanza: null }
  let allowEmptySentinel = true

  // Patch shift on the current outbound_q array
  const patchQueueShift = (q: any[]) => {
    const nativeShift = Array.prototype.shift
    q.shift = function() {
      if (this.length === 0) {
        // failQueue() uses `while (shift())` and must see undefined after the
        // queue drains. We temporarily disable the sentinel after emitting one
        // synthetic fail item so the next empty shift exits the loop cleanly.
        if (!allowEmptySentinel) {
          allowEmptySentinel = true
          return undefined
        }
        return SENTINEL
      }
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

  // Suppress synthetic events for sentinel items (stanza === null)
  const originalEmit = sm.emit.bind(sm)
  sm.emit = function(event: string, ...args: any[]) {
    if (args[0] === null) {
      if (event === 'fail') {
        allowEmptySentinel = false
      }
      if (event === 'ack' || event === 'fail') return false
    }
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
