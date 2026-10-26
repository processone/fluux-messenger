import type { Element } from '@xmpp/client'
import { NS_XMPP_STANZAS } from '../core/namespaces'

/**
 * RFC 6120 §8.3 error type categories.
 *
 * - cancel:   Do not retry (the error condition is not expected to change)
 * - continue: Proceed (the condition was only a warning)
 * - modify:   Retry after changing the data sent
 * - auth:     Provide credentials and retry
 * - wait:     Retry after waiting (the error is temporary)
 */
export type XMPPErrorType = 'cancel' | 'continue' | 'modify' | 'auth' | 'wait'

/**
 * Structured representation of an XMPP stanza error (RFC 6120 §8.3).
 *
 * Example error stanza:
 * ```xml
 * <error type="auth">
 *   <forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/>
 *   <text xmlns="urn:ietf:params:xml:ns:xmpp-stanzas">
 *     You are not allowed to invite users
 *   </text>
 * </error>
 * ```
 */
export interface XMPPStanzaError {
  /** Error category from the type attribute (cancel, auth, modify, wait, continue) */
  type: XMPPErrorType
  /** RFC-defined error condition element name (e.g. 'forbidden', 'not-allowed', 'item-not-found') */
  condition: string
  /** Optional human-readable error description from the <text> element */
  text?: string
}

const VALID_ERROR_TYPES = new Set<string>(['cancel', 'continue', 'modify', 'auth', 'wait'])

/**
 * Parse an XMPP `<error>` element into a structured object per RFC 6120 §8.3.
 *
 * Extracts the error type attribute, the defined condition element (in the
 * urn:ietf:params:xml:ns:xmpp-stanzas namespace), and the optional <text> element.
 *
 * @param errorEl - The `<error>` child element of a stanza, or the stanza itself
 *                  (in which case `getChild('error')` is called automatically).
 * @returns Parsed error object, or null if no valid error element is found.
 */
export function parseXMPPError(errorEl: Element | undefined | null): XMPPStanzaError | null {
  if (!errorEl) return null

  // If passed the parent stanza instead of the <error> child, extract it
  const el = errorEl.name === 'error' ? errorEl : errorEl.getChild('error')
  if (!el) return null

  // Extract error type attribute (RFC 6120 §8.3.2)
  const rawType = el.attrs?.type as string | undefined
  const type: XMPPErrorType = rawType && VALID_ERROR_TYPES.has(rawType)
    ? rawType as XMPPErrorType
    : 'cancel' // Default to 'cancel' for malformed errors

  // Find the defined condition element in the XMPP stanzas namespace (RFC 6120 §8.3.3)
  let condition = 'undefined-condition'
  for (const child of el.children ?? []) {
    if (typeof child === 'string') continue
    if (child.attrs?.xmlns === NS_XMPP_STANZAS && child.name !== 'text') {
      condition = child.name
      break
    }
  }

  // Extract optional <text> element (RFC 6120 §8.3.4)
  const textEl = el.getChild('text', NS_XMPP_STANZAS)
  const text = textEl?.getText() || undefined

  return { type, condition, text }
}

/**
 * Format an XMPPStanzaError into a human-readable string.
 *
 * Prefers the server-provided text when available, falls back to
 * converting the condition from kebab-case to a readable form
 * (e.g. 'not-allowed' → 'Not allowed').
 */
export function formatXMPPError(error: XMPPStanzaError): string {
  if (error.text) return error.text

  // Convert kebab-case condition to sentence case: 'not-allowed' → 'Not allowed'
  const words = error.condition.split('-')
  words[0] = words[0].charAt(0).toUpperCase() + words[0].slice(1)
  return words.join(' ')
}

/**
 * Check whether a caught error carries the given RFC 6120 defined condition.
 *
 * xmpp.js iqCaller rejections are StanzaErrors exposing `.condition`
 * (e.g. 'forbidden'); the error message is checked as a fallback for
 * errors that only carry the condition in their text.
 */
export function hasErrorCondition(err: unknown, condition: string): boolean {
  if ((err as { condition?: string } | null)?.condition === condition) return true
  return err instanceof Error && err.message.includes(condition)
}

const NS_STREAM = 'http://etherx.jabber.org/streams'
const NS_STREAM_ERRORS = 'urn:ietf:params:xml:ns:xmpp-streams'
const NS_SASL = 'urn:ietf:params:xml:ns:xmpp-sasl'
const NS_SASL2 = 'urn:xmpp:sasl:2'

// ltx semantics, as xmpp.js's own `is()` uses: prefix-free name, inherited namespace.
type Ltx = { getNS?: () => string; getName?: () => string }
function elementNs(el: Element): string | undefined {
  return (el as Ltx).getNS?.() ?? el.attrs?.xmlns
}
function elementName(el: Element): string {
  return (el as Ltx).getName?.() ?? el.name
}

/**
 * Order an error's children the way xmpp.js reads them: the defined condition
 * (in `ns`), then the protocol `<text/>` (in `textNs`), then everything else
 * with any other `<text/>` last. `@xmpp/error` takes children 1, 2 and 3 as
 * condition, text-or-application and application, and recognises text by
 * name alone, so a foreign-namespace `<text/>` must not sit ahead of the
 * protocol text or of the application element.
 */
function conditionFirst(errorEl: Element, ns: string, textNs: readonly string[]): void {
  const children = errorEl.children
  if (!Array.isArray(children)) return
  const isElement = (c: unknown): c is Element => typeof c !== 'string'
  const isText = (c: Element) => elementName(c) === 'text'
  const condition = children.find(c => isElement(c) && !isText(c) && elementNs(c) === ns)
  if (!condition) return
  const protocolText = children.filter(c => isElement(c) && isText(c) && textNs.includes(elementNs(c) ?? ''))
  const foreignText = children.filter(c => isElement(c) && isText(c) && !protocolText.includes(c))
  const rest = children.filter(c => c !== condition && !protocolText.includes(c) && !foreignText.includes(c))
  children.splice(0, children.length, condition, ...protocolText, ...rest, ...foreignText)
}

/**
 * Put an incoming error's defined condition first among its children, in place.
 *
 * xmpp.js 0.14 (`@xmpp/error`) takes the FIRST child element as the condition,
 * and acts on it while parsing (`see-other-host` redirects, rejected FAST
 * tokens, auth failures). RFC 6120 (§4.9.3, §6.5, §8.3.2) does not fix the
 * child order, and ejabberd 26.09 (xmpp 1.13.5) sends `<text/>` before the
 * condition, so the condition read as `text`. Covers stream errors, SASL
 * failures and stanza errors. Call it before xmpp.js reads the element.
 */
export function putErrorConditionFirst(el: Element): void {
  if (elementName(el) === 'error' && elementNs(el) === NS_STREAM) {
    conditionFirst(el, NS_STREAM_ERRORS, [NS_STREAM_ERRORS])
  } else if (elementName(el) === 'failure' && (elementNs(el) === NS_SASL || elementNs(el) === NS_SASL2)) {
    conditionFirst(el, NS_SASL, [NS_SASL, NS_SASL2])
  } else if (el.attrs?.type === 'error') {
    const errorEl = el.getChild?.('error')
    if (errorEl) conditionFirst(errorEl, NS_XMPP_STANZAS, [NS_XMPP_STANZAS])
  }
}

/**
 * Make an xmpp.js connection read error conditions by namespace. Wraps the
 * instance's element entry point, which runs before any of its own error
 * handling (the `error` event comes too late for the redirect and FAST paths).
 */
export function installOrderTolerantErrors(client: object): void {
  const target = client as { _onElement?: (el: Element) => unknown }
  const onElement = target._onElement
  if (typeof onElement !== 'function') return
  target._onElement = function (this: unknown, el: Element) {
    putErrorConditionFirst(el)
    return onElement.call(this, el)
  }
}
