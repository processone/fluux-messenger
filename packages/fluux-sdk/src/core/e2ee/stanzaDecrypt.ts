/**
 * Shared inbound-decrypt step for any message source.
 *
 * Live stanzas (handled by {@link Chat}) and archived stanzas (handled by
 * {@link MAM}) both arrive as `<message>` elements that may carry an
 * E2EE-claimed child plus a XEP-0373 hint body. Historically only the live
 * path decrypted them; MAM would surface the hint body verbatim and the
 * ciphertext was never opened. Both paths now route through
 * {@link decryptStanzaInPlace}, which is the single place that knows how to:
 *
 * - look up a plugin claim,
 * - call {@link E2EEManager.decryptInbound} with the sender as the peer,
 * - strip the encrypted child so the stanza doesn't get re-claimed on a
 *   second pass,
 * - replace the hint `<body>` with the plaintext on success,
 * - keep the sender-supplied hint (or synthesize a placeholder) on failure,
 * - stash the resulting security context on the stanza so downstream
 *   parsers can attach it to the emitted {@link Message}.
 */
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { elementToData } from './stanzaAdapter'
import type { E2EEManager, SecurityContext } from './index'
import { logWarn } from '../logger'

const DECRYPTED_MARKER = '__e2eeDecrypted'
const SECURITY_CONTEXT_STASH = '__securityContext'

/**
 * Result of {@link decryptStanzaInPlace}. `attempted` is true whenever a
 * plugin claimed one of the stanza's children — regardless of whether the
 * decrypt itself succeeded. Callers use it to decide whether the security
 * context stash should be consulted.
 */
export interface DecryptInPlaceResult {
  attempted: boolean
  securityContext?: SecurityContext
}

/**
 * Mutates `stanza` so that, if an E2EE plugin claims one of its children,
 * the stanza is decrypted in place and tagged with a security context.
 *
 * @param stanza - The `<message>` element (live or MAM-forwarded).
 * @param manager - The registered E2EE manager.
 * @param senderPeer - Bare JID of the peer whose conversation this decrypt
 *   should open. For live messages this is `bareFrom`; for archived
 *   messages it's the conversation partner (which may differ from `from`
 *   when the archived message is a carbon/self-outgoing entry — callers
 *   are responsible for that mapping).
 */
export async function decryptStanzaInPlace(
  stanza: Element,
  manager: E2EEManager,
  senderPeer: string,
): Promise<DecryptInPlaceResult> {
  const marked = stanza as unknown as {
    [DECRYPTED_MARKER]?: boolean
    [SECURITY_CONTEXT_STASH]?: SecurityContext
  }
  if (marked[DECRYPTED_MARKER]) {
    return {
      attempted: true,
      ...(marked[SECURITY_CONTEXT_STASH] && {
        securityContext: marked[SECURITY_CONTEXT_STASH],
      }),
    }
  }

  let claim: ReturnType<E2EEManager['claimInbound']> = null
  let encryptedChild: Element | null = null
  for (const child of stanza.children) {
    if (typeof child === 'string') continue
    const childEl = child as Element
    const c = manager.claimInbound(elementToData(childEl))
    if (c) {
      claim = c
      encryptedChild = childEl
      break
    }
  }
  if (!claim || !encryptedChild) {
    return { attempted: false }
  }

  let plaintext: string | null = null
  let securityContext: SecurityContext | null = null
  let failureReason: string | null = null

  try {
    const result = await manager.decryptInbound(claim.payload.stanzaElement, {
      kind: 'direct',
      peer: senderPeer,
    })
    if (result) {
      plaintext = new TextDecoder().decode(result.plaintext)
      securityContext = result.securityContext
    } else {
      failureReason = 'no plugin claimed the payload'
    }
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err)
  }

  // Always strip the encrypted element — either we replace the body with
  // plaintext (success) or we fall through to whatever fallback <body> the
  // sender included per XEP-0373. Leaving the encrypted element in place
  // would cause re-entry to claim it again and loop.
  const encryptedIdx = stanza.children.indexOf(encryptedChild)
  if (encryptedIdx >= 0) stanza.children.splice(encryptedIdx, 1)

  if (failureReason !== null) {
    logWarn(`E2EE decrypt failed for message from ${senderPeer}: ${failureReason}`)
    // XEP-0373: a well-behaved sender inserted a fallback <body> for
    // clients that cannot decrypt. Leave it alone. Synthesize a minimal
    // placeholder only when none was provided, so the message still
    // surfaces rather than being silently dropped.
    if (!stanza.getChild('body')) {
      stanza.children.push(
        xml('body', {}, '[Encrypted message: could not decrypt]'),
      )
    }
    securityContext = {
      protocolId: claim.plugin.descriptor.id,
      trust: 'untrusted',
      notes: ['Could not decrypt'],
    }
  } else if (plaintext !== null) {
    const bodyEl = stanza.getChild('body')
    if (bodyEl) {
      bodyEl.children = [plaintext]
    } else {
      stanza.children.push(xml('body', {}, plaintext))
    }
  }

  if (securityContext) {
    marked[SECURITY_CONTEXT_STASH] = securityContext
  }
  marked[DECRYPTED_MARKER] = true

  return {
    attempted: true,
    ...(securityContext && { securityContext }),
  }
}

/**
 * Read back the security context that {@link decryptStanzaInPlace} stashed
 * on a stanza. Returns `undefined` for stanzas that were never claimed by a
 * plugin (cleartext messages).
 */
export function readStashedSecurityContext(
  stanza: Element,
): SecurityContext | undefined {
  return (stanza as unknown as { [SECURITY_CONTEXT_STASH]?: SecurityContext })[
    SECURITY_CONTEXT_STASH
  ]
}

/**
 * Fast synchronous probe: does any child of this stanza look like something
 * a registered E2EE plugin would claim? Used by the live path to decide
 * whether to short-circuit normal processing in favour of the async
 * decrypt-and-reprocess flow. Pure peek — doesn't mutate the stanza or
 * advance any plugin state.
 */
export function stanzaHasE2EEClaim(
  stanza: Element,
  manager: E2EEManager,
): boolean {
  const marked = stanza as unknown as { [DECRYPTED_MARKER]?: boolean }
  if (marked[DECRYPTED_MARKER]) return false
  for (const child of stanza.children) {
    if (typeof child === 'string') continue
    if (manager.claimInbound(elementToData(child as Element))) return true
  }
  return false
}
