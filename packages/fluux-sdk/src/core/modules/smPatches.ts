/**
 * Stream Management monkey-patches for xmpp.js
 *
 * These patches are applied at runtime to the xmpp.js client instance created
 * in Connection.createXmppClient(). They address five issues:
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
 *    While the client is inactive, acks are sent at once instead: a hidden
 *    mobile web view may be suspended before a timer fires, and a stanza left
 *    unacknowledged when the session goes pending makes the server push it
 *    again (ejabberd mod_push), duplicating a notification already shown.
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
 * 3. **SM inbound count of consumed stanzas** (patchSmInboundCount):
 *    XEP-0198's inbound counter `h` must count every stanza received. In
 *    @xmpp/client 0.14.0 the iq caller is registered before the stream-
 *    management middleware that counts, and it ends the middleware chain
 *    when an `<iq type="result|error"/>` answers one of our own requests
 *    (the iq callee does the same when it rejects a malformed query). Those
 *    stanzas never reach the counter, so every `<a h/>` and `<resume h/>`
 *    reports too few, and on each resume the server resends stanzas the
 *    client already handled. The gap also keeps growing in the server's
 *    unacknowledged queue over a session. Upstream main registers the
 *    plugins in the same order.
 *
 *    Mechanics: an 'element' listener ahead of the middleware reads
 *    sm.inbound and one after it compares. The middleware counts
 *    synchronously during the same 'element' event, so a stanza that leaves
 *    the counter unchanged was consumed before it and is counted here, once.
 *    If a later xmpp.js counts these stanzas itself, the counter has already
 *    moved and the patch adds nothing.
 *
 * 4. **SM outbound count of unparsable addresses** (patchSmOutboundCount):
 *    xmpp.js writes a stanza, then builds an outgoing context that parses its
 *    `to` and `from`. An address with no domain, such as `@`, throws there,
 *    before the stream-management filter queues the stanza. The server still
 *    counts it (ejabberd 26.09 does for iq, message and presence), so its
 *    acknowledgement would release the next queued stanza instead.
 *
 * 5. **SM resend after a resumption** (patchSmResumeQueue):
 *    Connection builds a new xmpp.js client for every reconnect and hands it
 *    the unacknowledged stanzas of the previous one. The server's `h` in
 *    `<resumed/>` says which of them it never received. This patch applies it
 *    before xmpp.js resends its queue, for two reasons: the saved count can be
 *    ahead of `h` after a page reload, and would hold back later acks; and only
 *    messages are resent. A request's caller is gone with the old client, and a
 *    presence may be out of date, so those stay unsent as they did before. A
 *    console message with an unparsable address (patch 4) is not resent either:
 *    xmpp.js would throw on it and abort the resumption.
 *    When the server instead enables a new session through Bind 2, xmpp.js
 *    keeps its queue and count, so this patch clears them: nothing from the
 *    old session may be resent in the new one.
 *
 * @module
 */

import type { Client, Element, SmOutboundQueueItem, StreamManagement } from '@xmpp/client'
import { jid, xml } from '@xmpp/client'
import { parse as parseXml } from 'ltx'

const NS_SM = 'urn:xmpp:sm:3'
const NS_SASL2 = 'urn:xmpp:sasl:2'
const NS_BIND2 = 'urn:xmpp:bind:0'
const DEBOUNCE_MS = 250

/** State for SM ack debounce — stored per Connection instance */
export interface SmPatchState {
  smAckDebounceTimer: ReturnType<typeof setTimeout> | null
  originalEntitySend: ((stanza: Element) => Promise<void>) | null
  /** Send acks without debouncing; kept across reconnects like the client state. */
  ackImmediately: boolean
}

/** Create initial patch state */
export function createSmPatchState(): SmPatchState {
  return {
    smAckDebounceTimer: null,
    originalEntitySend: null,
    ackImmediately: false,
  }
}

function sendFreshAck(state: SmPatchState, sm: StreamManagement): Promise<void> {
  if (state.smAckDebounceTimer) {
    clearTimeout(state.smAckDebounceTimer)
    state.smAckDebounceTimer = null
  }
  if (!state.originalEntitySend) return Promise.resolve()
  return state.originalEntitySend(xml('a', { xmlns: NS_SM, h: String(sm.inbound) }))
}

/**
 * Switch between debounced and immediate acks. Entering immediate mode also
 * acknowledges everything received so far: XEP-0198 lets a client send <a/>
 * at any time, without waiting for the server's <r/>.
 */
export function setSmAckImmediate(state: SmPatchState, xmppClient: Client | null, immediate: boolean): void {
  state.ackImmediately = immediate
  const sm = xmppClient?.streamManagement
  if (immediate && sm?.enabled) sendFreshAck(state, sm).catch(() => {})
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
  const sm = xmppClient.streamManagement
  // Guard: only patch real xmpp.js clients (not test mocks which lack outbound_q)
  if (!Array.isArray(sm?.outbound_q)) return

  state.originalEntitySend = xmppClient.send.bind(xmppClient)
  const originalSend = state.originalEntitySend

  xmppClient.send = ((stanza: Element): Promise<void> => {
    // Only debounce SM ack stanzas: <a xmlns="urn:xmpp:sm:3" h="N"/>
    if (stanza.name === 'a' && stanza.attrs?.xmlns === NS_SM) {
      if (state.ackImmediately) return sendFreshAck(state, sm).catch(() => {})
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
export function patchSmAckQueue(sm: StreamManagement): void {
  if (!Array.isArray(sm.outbound_q) || typeof sm.emit !== 'function') return

  // Sentinel: has .stanza property to prevent crash in ackQueue's `item.stanza`
  const SENTINEL = { stanza: null }
  let allowEmptySentinel = true

  // Patch shift on the current outbound_q array
  const patchQueueShift = (q: SmOutboundQueueItem[]) => {
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
    set: (val: SmOutboundQueueItem[]) => {
      currentQ = val
      if (Array.isArray(val)) patchQueueShift(val)
    },
    configurable: true,
  })

  // Suppress synthetic events for sentinel items (stanza === null)
  const originalEmit = sm.emit.bind(sm)
  sm.emit = function(event: string, ...args: unknown[]) {
    if (args[0] === null) {
      if (event === 'fail') {
        allowEmptySentinel = false
      }
      if (event === 'ack' || event === 'fail') return false
    }
    return originalEmit(event, ...args)
  }
}

/** Stanza element names XEP-0198 counts, as xmpp.js's own counter checks them. */
const COUNTED_STANZAS = new Set(['iq', 'message', 'presence'])

/**
 * Count, in sm.inbound, the stanzas xmpp.js consumes before its stream-management
 * middleware sees them: replies to our own iq requests, and malformed queries the
 * iq callee answers itself. See the module documentation (patch 3).
 *
 * Guard: only patches real xmpp.js clients — test mocks (which lack outbound_q)
 * are left untouched.
 */
export function patchSmInboundCount(xmppClient: Client): void {
  const sm = xmppClient.streamManagement
  if (!Array.isArray(sm?.outbound_q) || typeof xmppClient.prependListener !== 'function') return

  // Counter value seen just before the middleware ran, per stanza element.
  const inboundBefore = new WeakMap<Element, number>()
  xmppClient.prependListener('element', (element: Element) => {
    if (COUNTED_STANZAS.has(element.name)) inboundBefore.set(element, sm.inbound)
  })
  xmppClient.on('element', (element: Element) => {
    const before = inboundBefore.get(element)
    if (before === undefined) return
    inboundBefore.delete(element)
    if (sm.inbound === before) sm.inbound += 1
  })
}

/** Whether xmpp.js's outgoing context would throw on this stanza's `to` or `from`. */
function hasUnparsableAddress(stanza: Element): boolean {
  try {
    for (const address of [stanza.attrs.to, stanza.attrs.from]) {
      if (address) jid(address)
    }
    return false
  } catch {
    return true
  }
}

/**
 * Queue the stanzas xmpp.js cannot build an outgoing context for, on the same
 * condition as its own filter. See the module documentation (patch 4). The send
 * still rejects as it did; only the count changes.
 *
 * Guard: only patches real xmpp.js clients — test mocks (which lack outbound_q)
 * are left untouched.
 */
export function patchSmOutboundCount(xmppClient: Client): void {
  const sm = xmppClient.streamManagement
  if (!Array.isArray(sm?.outbound_q) || typeof xmppClient.prependListener !== 'function') return

  xmppClient.prependListener('send', (element: Element) => {
    if (!COUNTED_STANZAS.has(element.name) || (!sm.enabled && !sm.enableSent)) return
    if (hasUnparsableAddress(element)) {
      sm.outbound_q.push({ stanza: element, stamp: new Date().toISOString() })
    }
  })
}

/**
 * Report the stanzas of a raw XML write to xmpp.js, as its own send() does after
 * writing an element. `client.write()` skips that step, while the server still
 * counts each stanza in its `h`; without this, an acknowledgement of a raw stanza
 * would release the next queued stanza instead.
 *
 * The caller's bytes are already on the wire, so they stay exactly as typed. Only
 * iq, message and presence are reported: the server does not count anything else.
 * Malformed XML reports nothing, because the server ends the stream and its
 * session on it. A listener that throws, as xmpp.js's does on an unparsable
 * address, neither fails the send nor stops the listeners after it.
 *
 * Guard: only real xmpp.js clients — test mocks (which lack outbound_q) are left
 * untouched.
 */
export function reportRawStanzasSent(xmppClient: Client, rawXml: string): void {
  if (!Array.isArray(xmppClient.streamManagement?.outbound_q)) return
  let written: Element
  try {
    written = parseXml(`<raw>${rawXml}</raw>`) as unknown as Element
  } catch {
    return
  }
  // The listeners of the `send` event, which is not on the SDK-facing declaration.
  const emitter = xmppClient as unknown as { rawListeners: (event: 'send') => ((element: Element) => void)[] }
  for (const child of written.children) {
    if (typeof child === 'string' || !COUNTED_STANZAS.has(child.name)) continue
    for (const listener of emitter.rawListeners('send')) {
      try {
        listener.call(xmppClient, child)
      } catch {
        // The stanza is already on the wire.
      }
    }
  }
}

/** The `<resumed/>` of a stream-feature resumption or of an inline SASL2 one. */
function findResumed(element: Element): Element | undefined {
  if (element.is('resumed', NS_SM)) return element
  if (!element.is('success', NS_SASL2)) return undefined
  return element.getChild('resumed', NS_SM) ?? element.getChild('bound', NS_BIND2)?.getChild('resumed', NS_SM)
}

/** A SASL2 success where Bind 2 enabled a new session. A refused resumption is left to xmpp.js. */
function startsNewSession(element: Element): boolean {
  return element.is('success', NS_SASL2)
    && !element.getChild('failed', NS_SM)
    && !!element.getChild('bound', NS_BIND2)?.getChild('enabled', NS_SM)
}

/**
 * When the server resumes the session, leave in the queue only the messages it
 * never received, and set the sent count to its `h`. xmpp.js then finds nothing
 * to acknowledge and resends exactly that queue. When it starts a new session
 * through Bind 2 instead, empty the queue and the count. See the module
 * documentation (patch 5).
 *
 * Runs ahead of xmpp.js, which handles `<resumed/>` after this 'element' event.
 *
 * Guard: only patches real xmpp.js clients — test mocks (which lack outbound_q)
 * are left untouched.
 */
export function patchSmResumeQueue(xmppClient: Client): void {
  const sm = xmppClient.streamManagement
  if (!Array.isArray(sm?.outbound_q) || typeof xmppClient.prependListener !== 'function') return

  xmppClient.prependListener('element', (element: Element) => {
    if (startsNewSession(element)) {
      // Nothing can have been sent in the new session yet. Without the old id, a
      // success that then fails its server signature leaves the kept stanzas alone.
      sm.id = ''
      sm.outbound = 0
      sm.outbound_q = []
      return
    }
    const resumed = findResumed(element)
    if (!resumed) return
    const h = Number(resumed.attrs.h)
    if (!Number.isSafeInteger(h) || h < 0) return
    const notReceived = sm.outbound_q.slice(Math.max(0, h - sm.outbound))
    sm.outbound = h
    // xmpp.js throws on an address it cannot parse, which would abort the resumption.
    sm.outbound_q = notReceived.filter(({ stanza }) => stanza?.name === 'message' && !hasUnparsableAddress(stanza))
  })
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
      const sm = xmppClient.streamManagement
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
