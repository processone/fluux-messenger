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
