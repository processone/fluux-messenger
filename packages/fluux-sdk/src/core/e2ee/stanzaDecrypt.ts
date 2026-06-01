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
import { parse as parsePayloadEnvelope } from './payloadEnvelope'
import type { E2EEManager, SecurityContext } from './index'
import { isE2EEPluginError } from './errors'
import type { InboundDecryptContext, InboundSource } from './types'
import { getBareJid } from '../jid'
import { logWarn, logInfo } from '../logger'
import { NS_EME } from '../namespaces'

const DECRYPTED_MARKER = '__e2eeDecrypted'
const SECURITY_CONTEXT_STASH = '__securityContext'
const AUTHORED_AT_STASH = '__authoredAt'
const ENCRYPTED_PAYLOAD_STASH = '__encryptedPayload'

/**
 * Result of {@link decryptStanzaInPlace}. `attempted` is true whenever a
 * plugin claimed one of the stanza's children — regardless of whether the
 * decrypt itself succeeded. Callers use it to decide whether the security
 * context stash should be consulted.
 */
export interface DecryptInPlaceResult {
  attempted: boolean
  securityContext?: SecurityContext
  /**
   * Sender-attested composition time recovered from inside the decrypted
   * envelope (e.g. XEP-0373 §4.1 `<time stamp='…'/>`). Callers that care
   * about authentic timestamps — message list ordering, MAM replay —
   * should prefer this over the stanza's `<delay/>` or arrival time.
   */
  authoredAt?: Date
  /**
   * Serialized XML of the encrypted child element, present only when
   * decryption was attempted but failed (key locked, unsupported protocol)
   * or when an EME hint was detected but no plugin claimed the stanza.
   * Callers should store this on the resulting {@link Message} so that
   * {@link XMPPClient.retryPendingDecrypts} can re-attempt later.
   */
  encryptedPayloadXml?: string
}

/**
 * Mutates `stanza` so that, if an E2EE plugin claims one of its children,
 * the stanza is decrypted in place and tagged with a security context.
 *
 * @param stanza - The `<message>` element (live or MAM-forwarded).
 * @param manager - The registered E2EE manager.
 * @param senderPeer - Bare JID of the **conversation peer** whose handle the
 *   plugin should open. For received messages this is `bareFrom`; for
 *   self-outgoing entries (XEP-0280 sent carbons, XEP-0313 MAM self-replays)
 *   it's the recipient (`bareTo`) — callers are responsible for that mapping.
 *   Pair the `bareTo` mapping with `options.isSelfOutgoing = true` so the
 *   plugin can invert its peer-key / reflection checks.
 * @param source - `'live'` for freshly-delivered stanzas, `'archive'` for
 *   stanzas replayed from XEP-0313 MAM. Routing through the archive path
 *   lets ratcheting plugins (OMEMO/MLS) decrypt history without advancing
 *   their live session state; stateless plugins (OpenPGP) see no
 *   difference. Defaults to `'live'` for backwards compatibility.
 * @param options - Optional context forwarded to the plugin's `decrypt`
 *   call. `isSelfOutgoing` signals that we are decrypting one of our own
 *   messages (sent-carbon or self-MAM-replay) and the plugin should branch
 *   its sender-key / envelope-addressees logic accordingly.
 */
export async function decryptStanzaInPlace(
  stanza: Element,
  manager: E2EEManager,
  senderPeer: string,
  source: InboundSource = 'live',
  options?: { isSelfOutgoing?: boolean },
): Promise<DecryptInPlaceResult> {
  const marked = stanza as unknown as {
    [DECRYPTED_MARKER]?: boolean
    [SECURITY_CONTEXT_STASH]?: SecurityContext
    [AUTHORED_AT_STASH]?: Date
  }
  if (marked[DECRYPTED_MARKER]) {
    return {
      attempted: true,
      ...(marked[SECURITY_CONTEXT_STASH] && {
        securityContext: marked[SECURITY_CONTEXT_STASH],
      }),
      ...(marked[AUTHORED_AT_STASH] && {
        authoredAt: marked[AUTHORED_AT_STASH],
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
    // No plugin claimed — check if this is still an encrypted message via
    // XEP-0380 EME (Explicit Message Encryption). This happens when no
    // plugin is registered yet (race at startup) or the message uses a
    // protocol this client doesn't support. Stash the encrypted element
    // so retryPendingDecrypts() can re-attempt when a plugin is available.
    const payloadXml = stashEncryptedPayloadViaEME(stanza)
    return { attempted: false, ...(payloadXml && { encryptedPayloadXml: payloadXml }) }
  }

  // Serialize the encrypted element BEFORE any mutation — the element
  // will be stripped below regardless of success/failure.
  const encryptedChildXml = encryptedChild.toString()

  let plaintext: string | null = null
  let securityContext: SecurityContext | null = null
  let authoredAt: Date | null = null
  let failureReason: string | null = null

  try {
    const messageId = stanza.attrs.id
    const isSelfOutgoing = options?.isSelfOutgoing === true
    const fromArchive = source === 'archive'
    const context: InboundDecryptContext | undefined =
      messageId || isSelfOutgoing || fromArchive
        ? {
            ...(messageId && { messageId }),
            ...(isSelfOutgoing && { isSelfOutgoing: true as const }),
            ...(fromArchive && { fromArchive: true as const }),
          }
        : undefined
    const target = { kind: 'direct' as const, peer: senderPeer }
    const result =
      source === 'archive'
        ? await manager.decryptArchive(claim.payload.stanzaElement, target, context)
        : await manager.decryptInbound(claim.payload.stanzaElement, target, context)
    if (result) {
      plaintext = new TextDecoder().decode(result.plaintext)
      securityContext = result.securityContext
      if (result.authoredAt) authoredAt = result.authoredAt
    } else {
      failureReason = 'no plugin claimed the payload'
    }
  } catch (err) {
    failureReason = err instanceof Error ? err.message : String(err)
    if (isE2EEPluginError(err) && (err.code === 'signature-failed' || err.code === 'signature-missing')) {
      securityContext = {
        protocolId: claim.plugin.descriptor.id,
        trust: 'rejected',
        notes: [failureReason],
      }
    }
  }

  // Always strip the encrypted element — either we replace the body with
  // plaintext (success) or we fall through to whatever fallback <body> the
  // sender included per XEP-0373. Leaving the encrypted element in place
  // would cause re-entry to claim it again and loop.
  const encryptedIdx = stanza.children.indexOf(encryptedChild)
  if (encryptedIdx >= 0) stanza.children.splice(encryptedIdx, 1)

  if (failureReason !== null) {
    const isRejection = securityContext?.trust === 'rejected'
    logWarn(`E2EE decrypt failed for message from ${senderPeer}: ${failureReason}`)
    if (isRejection) {
      // Signature rejection: suppress any sender-supplied body hint and
      // replace with a client-side placeholder. Do NOT stash for deferred
      // retry — the rejection is final.
      const existingBody = stanza.getChild('body')
      if (existingBody) {
        existingBody.children = ['[Message rejected: invalid signature]']
      } else {
        stanza.children.push(
          xml('body', {}, '[Message rejected: invalid signature]'),
        )
      }
    } else {
      // Decrypt failure (key locked, plugin missing, etc.): stash for
      // deferred retry and keep the sender's fallback body hint.
      stashPayload(stanza, encryptedChildXml)
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
    }
  } else if (plaintext !== null) {
    // Plaintext can come in two shapes. New senders ship an XML payload
    // envelope — `<payload xmlns='jabber:client'>…children…</payload>` —
    // that carries `<body/>` alongside stanza extensions (XEP-0066 OOB,
    // XEP-0446 file-metadata, and in later phases chat states / receipts
    // / reactions / reply). We unwrap those children back onto the stanza
    // root so the existing parsers (parseOobData, chat-state handler, …)
    // continue to work unchanged — the decrypted stanza looks structurally
    // identical to a plaintext stanza carrying the same elements.
    //
    // Legacy senders (including our own code before this change) ship a
    // bare body string as the plaintext. `parsePayloadEnvelope` returns
    // `null` for that shape, and we fall back to replacing just `<body/>`.
    const envelopeChildren = parsePayloadEnvelope(plaintext)
    if (envelopeChildren) {
      // Drop any existing body hint so the decrypted one wins.
      const existingBody = stanza.getChild('body')
      if (existingBody) {
        const idx = stanza.children.indexOf(existingBody)
        if (idx >= 0) stanza.children.splice(idx, 1)
      }
      for (const child of envelopeChildren) {
        stanza.children.push(child)
      }
    } else {
      const bodyEl = stanza.getChild('body')
      if (bodyEl) {
        bodyEl.children = [plaintext]
      } else {
        stanza.children.push(xml('body', {}, plaintext))
      }
    }
  }

  // Decrypt succeeded but the plugin reported untrusted trust (e.g. peer
  // key not yet cached so the signature could not be verified). Stash
  // the encrypted payload so retryPendingDecrypts() can re-verify the
  // signature once the peer key arrives — same mechanism used for full
  // decrypt failures, but here the body is already correct.
  const needsDeferredVerification =
    failureReason === null && securityContext?.trust === 'untrusted'
  if (needsDeferredVerification) {
    stashPayload(stanza, encryptedChildXml)
  }

  if (securityContext) {
    marked[SECURITY_CONTEXT_STASH] = securityContext
  }
  if (authoredAt) {
    marked[AUTHORED_AT_STASH] = authoredAt
  }
  marked[DECRYPTED_MARKER] = true

  return {
    attempted: true,
    ...(securityContext && { securityContext }),
    ...(authoredAt && { authoredAt }),
    ...((failureReason !== null && securityContext?.trust !== 'rejected' || needsDeferredVerification) && {
      encryptedPayloadXml: encryptedChildXml,
    }),
  }
}

// ---------------------------------------------------------------------------
// Conversation-context derivation
// ---------------------------------------------------------------------------

/**
 * From a `<message>` element and the account's own bare JID, derive
 * the conversation peer plus whether this stanza is one of our own
 * outgoing messages being delivered back to us (XEP-0280 sent carbon
 * or XEP-0313 MAM self-replay).
 *
 * The single rule both the live (`Chat`) and archive (`MAM`) paths
 * follow: if the message's bare `from` is our own JID, the message
 * originated from one of our devices — the conversation peer is then
 * the recipient (`to`), and the plugin needs `isSelfOutgoing: true`
 * to invert its sender-key / envelope-addressees checks. Otherwise
 * the peer is the sender (`from`).
 *
 * Centralizing this here is load-bearing: the bug Adrien reported in
 * production was that the live path used the message's `from` as the
 * peer for sent carbons (i.e. our own JID), while the archive path
 * mapped to `to` correctly. Now both call this helper.
 *
 * Note for MUC: room messages have `from = roomJid/nickname` and
 * `to = our-jid/resource`, so `bareFrom !== ownBareJid` — the helper
 * naturally returns `peer = roomJid` and `isSelfOutgoing = false`.
 *
 * @param messageEl - The `<message>` element after carbon unwrapping
 *   (live path) or after MAM `<forwarded>` extraction (archive path).
 * @param ownBareJid - The current account's bare JID. Empty string
 *   disables self-outgoing detection (defensive fallback for callers
 *   that may not yet have a current JID).
 */
export function deriveConversationContext(
  messageEl: Element,
  ownBareJid: string,
): { peer: string; isSelfOutgoing: boolean } {
  const bareFrom = messageEl.attrs.from ? getBareJid(messageEl.attrs.from) : ''
  const bareTo = messageEl.attrs.to ? getBareJid(messageEl.attrs.to) : ''
  const isSelfOutgoing = ownBareJid !== '' && bareFrom === ownBareJid
  return {
    peer: isSelfOutgoing ? bareTo : bareFrom,
    isSelfOutgoing,
  }
}

// ---------------------------------------------------------------------------
// Stanza stash helpers
// ---------------------------------------------------------------------------

/** Stash a serialized encrypted element on a stanza for deferred decrypt. */
function stashPayload(stanza: Element, payloadXml: string): void {
  ;(stanza as unknown as { [ENCRYPTED_PAYLOAD_STASH]?: string })[
    ENCRYPTED_PAYLOAD_STASH
  ] = payloadXml
}

/**
 * EME-based fallback: when no plugin claimed the stanza, look for an
 * XEP-0380 `<encryption>` hint. If found, locate the encrypted child by
 * matching its namespace to the EME `namespace` attribute, serialize it,
 * and stash it on the stanza. Returns the serialized XML or `undefined`.
 */
function stashEncryptedPayloadViaEME(stanza: Element): string | undefined {
  const emeEl = stanza.getChild('encryption', NS_EME)
  if (!emeEl) return undefined
  const emeNamespace = emeEl.attrs.namespace
  if (!emeNamespace) return undefined

  for (const child of stanza.children) {
    if (typeof child === 'string') continue
    const childEl = child as Element
    if (childEl.attrs.xmlns === emeNamespace) {
      const payloadXml = childEl.toString()
      stashPayload(stanza, payloadXml)
      logInfo(`E2EE: stashed encrypted payload via EME (ns=${emeNamespace}) for deferred decrypt`)
      return payloadXml
    }
  }
  return undefined
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
 * Read back the sender-attested `authoredAt` timestamp that
 * {@link decryptStanzaInPlace} stashed on a stanza. Returns `undefined`
 * when the stanza wasn't E2EE-claimed, the plugin had no in-envelope
 * timestamp, or decrypt failed.
 */
export function readStashedAuthoredAt(stanza: Element): Date | undefined {
  return (stanza as unknown as { [AUTHORED_AT_STASH]?: Date })[AUTHORED_AT_STASH]
}

/**
 * Read back the serialized encrypted payload that was stashed on a stanza
 * because decryption failed or no plugin was available. Returns `undefined`
 * for cleartext messages or successfully-decrypted messages.
 */
export function readStashedEncryptedPayload(stanza: Element): string | undefined {
  return (stanza as unknown as { [ENCRYPTED_PAYLOAD_STASH]?: string })[
    ENCRYPTED_PAYLOAD_STASH
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

/**
 * Fast synchronous check: does this stanza carry an XEP-0380 EME hint
 * indicating it's encrypted, regardless of whether any plugin is registered?
 * Used by the live path when no E2EE manager or plugin is available to
 * detect messages that should carry an {@link encryptedPayload} for deferred
 * decryption.
 */
export function stanzaHasEMEHint(stanza: Element): boolean {
  return !!stanza.getChild('encryption', NS_EME)
}
