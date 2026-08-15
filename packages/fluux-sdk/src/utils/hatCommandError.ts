/**
 * Classification of a failed XEP-0317 hat ad-hoc command into a
 * {@link HatCommandError} carrying the reason.
 *
 * Kept separate from `MUC` so the mapping is unit-testable on its own and can
 * be reused by any other ad-hoc command surface.
 */
import { HatCommandError, RequestTimeoutError } from '../core/errors'
import type { XMPPErrorType } from './xmppError'

const VALID_ERROR_TYPES = new Set<string>(['cancel', 'continue', 'modify', 'auth', 'wait'])

/**
 * Shape of an `@xmpp/client` `StanzaError`: the rejection raised by `iqCaller`
 * when the peer answers with `<iq type="error">`.
 */
interface StanzaErrorLike {
  condition?: unknown
  text?: unknown
  type?: unknown
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Map an arbitrary failure raised while running a hat command to a
 * {@link HatCommandError}.
 *
 * Distinguishes the two cases a user needs to tell apart:
 * - the server never replied within the command's budget → `'timeout'`
 * - the server replied with an error → its RFC 6120 condition and `<text/>`
 *
 * Anything else (transport failure, unexpected exception) becomes
 * `'undefined-condition'`, which callers should render as their generic
 * failure message rather than inventing a cause.
 */
export function toHatCommandError(err: unknown, roomJid: string, node: string): HatCommandError {
  if (err instanceof HatCommandError) return err

  if (err instanceof RequestTimeoutError) {
    return new HatCommandError(roomJid, node, 'timeout', { cause: err })
  }

  const stanzaError = err as StanzaErrorLike | null | undefined
  const condition = asNonEmptyString(stanzaError?.condition)
  if (condition) {
    const rawType = stanzaError?.type
    return new HatCommandError(roomJid, node, condition, {
      errorType: typeof rawType === 'string' && VALID_ERROR_TYPES.has(rawType)
        ? rawType as XMPPErrorType
        : undefined,
      text: asNonEmptyString(stanzaError?.text),
      cause: err,
    })
  }

  return new HatCommandError(roomJid, node, 'undefined-condition', {
    message: err instanceof Error ? err.message : undefined,
    cause: err,
  })
}
