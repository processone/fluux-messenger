import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { BaseModule, type ModuleDependencies } from './BaseModule'
import { getBareJid, getLocalPart, getResource, isQuickChatJid } from '../jid'
import { isMucJid } from '../../utils/xmppUri'
import { generateUUID, generateStableMessageId } from '../../utils/uuid'
import {
  NS_CHATSTATES,
  NS_CARBONS,
  NS_FORWARD,
  NS_REACTIONS,
  NS_CORRECTION,
  NS_RETRACT,
  NS_OOB,
  NS_THUMBS,
  NS_FILE_METADATA,
  NS_FASTEN,
  NS_MUC_USER,
  NS_CONFERENCE,
  NS_EASTER_EGG,
  NS_REPLY,
  NS_FALLBACK,
  NS_REFERENCE,
  NS_MENTION_ALL,
  NS_HINTS,
  NS_EME,
  NS_FLUUX,
  NS_OCCUPANT_ID,
  NS_MESSAGE_MODERATE,
  NS_POLL,
  NS_DELAY,
} from '../namespaces'
import { dataToElement } from '../e2ee/stanzaAdapter'
import type { E2EEManager } from '../e2ee'
import { E2EEEncryptionRequiredError } from '../e2ee'
import {
  decryptStanzaInPlace,
  deriveConversationContext,
  readStashedAuthoredAt,
  readStashedEncryptedPayload,
  readStashedSecurityContext,
  readStashedUnsupportedEncryption,
  recordUnclaimedEME,
  stanzaHasE2EEClaim,
  stanzaHasEMEHint,
} from '../e2ee/stanzaDecrypt'
import { serialize as serializePayloadEnvelope } from '../e2ee/payloadEnvelope'
import { build as buildAesgcmUri } from './AesgcmUri'
import type {
  Message,
  MentionReference,
  FileAttachment,
  ChatStateNotification,
  MAMQueryOptions,
  MAMResult,
  MessageSecurityContext,
  RoomMessage,
  RoomMAMQueryOptions,
  RoomMAMResult,
  PollClosedData,
} from '../types'
import { parseMessageContent, parseOgpFastening, applyRetraction, applyCorrection, createOriginIdElement, parseStanzaId } from './messagingUtils'
import { checkForMention } from '../mentionDetection'
import { parsePollElement, parsePollClosedElement } from '../poll'
import { logWarn } from '../logger'
import { parseXMPPError, formatXMPPError } from '../../utils/xmppError'
import type { MAM } from './MAM'

/**
 * Chat module for 1:1 and group messaging.
 *
 * Handles sending and receiving messages, reactions, corrections, retractions,
 * chat states (typing indicators), and Message Archive Management (MAM).
 *
 * @remarks
 * This module is accessed via `client.chat` on the XMPPClient instance.
 * Most methods support both 1:1 chat and groupchat (MUC) message types.
 *
 * @example Sending a message
 * ```typescript
 * // Send a 1:1 message
 * await client.chat.sendMessage('user@example.com', 'Hello!')
 *
 * // Send a group chat message
 * await client.chat.sendMessage('room@conference.example.com', 'Hello room!', 'groupchat')
 * ```
 *
 * @example Sending a reply
 * ```typescript
 * await client.chat.sendMessage('user@example.com', 'I agree!', 'chat', {
 *   id: 'original-message-id',
 *   to: 'user@example.com',
 *   fallback: { author: 'User', body: 'What do you think?' }
 * })
 * ```
 *
 * @example Typing indicators
 * ```typescript
 * // User is typing
 * await client.chat.sendChatState('user@example.com', 'composing')
 *
 * // User stopped typing
 * await client.chat.sendChatState('user@example.com', 'paused')
 * ```
 *
 * @example Reactions (XEP-0444)
 * ```typescript
 * await client.chat.sendReaction('user@example.com', 'message-id', ['👍', '❤️'])
 * ```
 *
 * @example Message correction (XEP-0308)
 * ```typescript
 * await client.chat.sendCorrection('user@example.com', 'original-id', 'Fixed typo')
 * ```
 *
 * @example Message retraction (XEP-0424)
 * ```typescript
 * await client.chat.sendRetraction('user@example.com', 'message-id')
 * ```
 *
 * @example Fetching message history (XEP-0313 MAM)
 * ```typescript
 * const result = await client.chat.queryMAM({
 *   with: 'user@example.com',
 *   max: 50
 * })
 * console.log(`Fetched ${result.messages.length} messages`)
 * ```
 *
 * @category Core
 */
/**
 * Per-call tuning for {@link Chat.applyE2EEToOutboundChat}. Defaults preserve
 * the message-body behaviour; body-less signal stanzas (reactions, retract,
 * link previews, easter eggs) override them.
 */
interface E2EEOutboundOptions {
  /** Carry a `<body>` (the plaintextBody arg) inside the encrypted envelope. Default true. */
  encryptBody?: boolean
  /**
   * What to do with the OUTER stanza `<body>` after a successful encrypt:
   *  - 'fallback' (default): replace/insert the plugin's encrypted-fallback string
   *  - 'remove': strip any outer body (pure-signal stanzas)
   */
  outerBody?: 'fallback' | 'remove'
  /** Hint appended after the encrypted element on success. Default 'store'; 'none' appends nothing. */
  storeHint?: 'store' | 'no-store' | 'none'
}

export class Chat extends BaseModule {
  private mamModule: MAM

  constructor(deps: ModuleDependencies, mamModule: MAM) {
    super(deps)
    this.mamModule = mamModule
  }

  handle(stanza: Element): boolean | void {
    if (stanza.is('message')) {
      return this.handleMessage(stanza)
    }
    return false
  }

  private handleMessage(stanza: Element): boolean {
    const { handled } = this.handleMessageInternal(stanza)
    return handled
  }

  /**
   * Internal message handler that supports recursion for carbon copies.
   */
  private handleMessageInternal(
    stanza: Element,
    isCarbonCopy = false,
    isSentCarbon = false
  ): { handled: boolean; message?: Message | RoomMessage | null } {
    const carbonSent = stanza.getChild('sent', NS_CARBONS)
    const carbonReceived = stanza.getChild('received', NS_CARBONS)

    if (carbonSent || carbonReceived) {
      const forwarded = (carbonSent || carbonReceived)!.getChild('forwarded', NS_FORWARD)
      const forwardedMessage = forwarded?.getChild('message')
      if (forwardedMessage) {
        return this.handleMessageInternal(forwardedMessage, true, !!carbonSent)
      }
      return { handled: true }
    }

    // E2EE decrypt hook: if a registered plugin claims one of the stanza's
    // children, decrypt asynchronously, then re-enter this method with the
    // plaintext body in place of the encrypted element. Returning
    // `{ handled: true }` here prevents other modules from also processing
    // the encrypted stanza.
    if (this.tryHandleEncrypted(stanza, isCarbonCopy, isSentCarbon)) {
      return { handled: true }
    }

    // tryHandleEncrypted returned false: no plugin claimed the stanza (or there
    // is no manager). recordUnclaimedEME tags it — when a plugin is registered,
    // an unclaimed EME stanza is an unsupported protocol (e.g. OMEMO) so the
    // fallback <body> is shown with an "unsupported method" hint; otherwise the
    // payload is stashed for retryPendingDecrypts() once a plugin comes online.
    // The two `!readStashed…` guards make this idempotent across re-entry
    // (carbon copies / second passes through handleMessageInternal).
    const manager = this.deps.getE2EEManager?.()
    if (
      !readStashedEncryptedPayload(stanza) &&
      !readStashedUnsupportedEncryption(stanza) &&
      stanzaHasEMEHint(stanza)
    ) {
      recordUnclaimedEME(stanza, manager ?? false)
    }

    const from = stanza.attrs.from
    const to = stanza.attrs.to
    let type = stanza.attrs.type || 'chat'
    const hasMucUserElement = !!stanza.getChild('x', NS_MUC_USER)

    if (type === 'error') {
      this.handleErrorMessage(stanza, from)
      return { handled: true }
    }

    // XEP-0280: Ignore messages with <private/> element
    if (stanza.getChild('private', NS_CARBONS)) {
      return { handled: true }
    }

    // XEP-0045 §7.5: a type='chat' message whose `from` is an occupant of a
    // joined room (room@service/nick) is a private message ("whisper"), not a
    // public room message. Detect it BEFORE the muc#user→groupchat
    // reclassification below, which would otherwise surface it publicly.
    const isWhisper =
      type === 'chat' &&
      !!from && !!getResource(from) &&
      this.deps.stores?.room?.getRoom(getBareJid(from))?.joined === true

    if (type === 'chat' && hasMucUserElement && !isWhisper) {
      type = 'groupchat'
    }

    const body = stanza.getChildText('body')
    const bareFrom = from ? getBareJid(from) : undefined
    const bareTo = to ? getBareJid(to) : undefined

    if (!bareFrom) {
      return { handled: false }
    }

    // Whisper short-circuit: handle before the public sub-feature handlers
    // (chat states, reactions, corrections, retractions, moderation), which
    // are out of scope for whispers in v1.
    if (isWhisper) {
      if (body || stanza.getChild('x', NS_OOB)) {
        // from is non-null here: isWhisper guards !!from
        const whisper = this.processRoomWhisper(stanza, from!, bareFrom, body || '', isSentCarbon)
        if (whisper && !isSentCarbon) {
          this.deps.emit('message', whisper as unknown as Message)
        }
        return { handled: true, message: whisper }
      }
      // Bodyless whisper (e.g. a stray chat-state): claim and drop in v1.
      return { handled: true }
    }

    // Note: PubSub events are now handled by the PubSub module

    // MUC Invitations
    if (this.handleMucInvitation(stanza, bareFrom)) {
      return { handled: true }
    }

    // Chat States
    if (!isCarbonCopy) {
      this.handleChatState(stanza, from, bareFrom, bareTo, type)
    }

    // Reactions
    const reactionsEl = stanza.getChild('reactions', NS_REACTIONS)
    if (reactionsEl) {
      this.handleIncomingReaction(stanza, reactionsEl, from, bareFrom, bareTo, type, isSentCarbon)
      // Always treat reaction stanzas as handled — any body is fallback for legacy clients
      // (some clients may not include <fallback for="urn:xmpp:reactions:0"> indication)
      return { handled: true }
    }

    // Fastenings (Link Previews) / XEP-0425 v0 Moderation (via apply-to)
    const applyToEl = stanza.getChild('apply-to', NS_FASTEN)
    if (applyToEl) {
      // XEP-0425 v0: moderation wrapped in <apply-to> — check before link preview
      const moderatedV0 = applyToEl.getChild('moderated', 'urn:xmpp:message-moderate:0')
      if (moderatedV0 && applyToEl.attrs.id) {
        if (this.handleIncomingModeration(applyToEl.attrs.id, moderatedV0, bareFrom, type)) {
          return { handled: true }
        }
      }
      this.handleFastening(applyToEl, bareFrom, bareTo, type, isSentCarbon)
      return { handled: true }
    }

    // Corrections
    const replaceEl = stanza.getChild('replace', NS_CORRECTION)
    if (replaceEl?.attrs.id && body) {
      const handled = this.handleIncomingCorrection(
        stanza,
        replaceEl.attrs.id,
        from,
        bareFrom,
        bareTo,
        body,
        type,
        isSentCarbon
      )
      if (handled) return { handled: true }
    }

    // Retractions / XEP-0425 v1 Moderation (moderated inside retract)
    const retractEl = stanza.getChild('retract', NS_RETRACT)
    if (retractEl?.attrs.id) {
      // XEP-0425 v1: <moderated> nested inside <retract>
      const moderatedV1 = retractEl.getChild('moderated', NS_MESSAGE_MODERATE)
      if (moderatedV1) {
        if (this.handleIncomingModeration(retractEl.attrs.id, moderatedV1, bareFrom, type)) {
          return { handled: true }
        }
      }
      if (this.handleIncomingRetraction(
        retractEl.attrs.id,
        from,
        bareFrom,
        bareTo,
        type,
        isSentCarbon,
        stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id
      )) return { handled: true }
    }

    // XEP-0425: Message Moderation (legacy: moderated as direct child)
    const moderatedEl = stanza.getChild('moderated', NS_MESSAGE_MODERATE)
    if (moderatedEl?.attrs.id) {
      if (this.handleIncomingModeration(moderatedEl.attrs.id, moderatedEl, bareFrom, type)) {
        return { handled: true }
      }
    }

    // Easter eggs
    const easterEggEl = stanza.getChild('easter-egg', NS_EASTER_EGG)
    if (easterEggEl) {
      const animation = easterEggEl.attrs.animation
      if (animation) {
        // SDK event only - binding calls store.triggerAnimation
        if (type === 'groupchat') {
          this.deps.emitSDK('room:animation', { roomJid: bareFrom, animation })
        } else {
          this.deps.emitSDK('chat:animation', { conversationId: bareFrom, animation })
        }
      }
      return { handled: true }
    }

    // MUC Subject changes
    const subjectEl = stanza.getChild('subject')
    if (type === 'groupchat' && subjectEl) {
      const subject = subjectEl.getText() || ''
      // SDK event only - binding calls store.updateRoom
      this.deps.emitSDK('room:subject', { roomJid: bareFrom, subject })
      if (!body) return { handled: true }
    }

    // Process actual message
    // Poll messages have their body stripped by fallback processing, so also check for poll elements
    if (body || stanza.getChild('x', NS_OOB) || stanza.getChild('poll', NS_POLL) || stanza.getChild('poll-closed', NS_POLL)) {
      let message: Message | RoomMessage | null
      if (type === 'groupchat') {
        message = this.processRoomMessage(stanza, from, bareFrom, body || '', isCarbonCopy, isSentCarbon)
      } else {
        message = this.processChatMessage(stanza, from, bareFrom, bareTo, body || '', isCarbonCopy, isSentCarbon)
      }

      if (message) {
        if (!isSentCarbon) {
          this.deps.emit('message', message as Message)
        }
        return { handled: true, message }
      }
    }

    return { handled: false }
  }

  /**
   * Look for an E2EE-plugin-claimed element in this stanza. If found, kick
   * off the async decrypt-and-reprocess flow and return true. Returns false
   * if no manager is available, no plugin claims a child, or the stanza
   * has already been decrypted in a previous pass (guarded by a marker).
   *
   * The actual decrypt step lives in {@link decryptStanzaInPlace} and is
   * shared with the MAM module so archived encrypted messages go through
   * the exact same pipeline.
   */
  private tryHandleEncrypted(
    stanza: Element,
    isCarbonCopy: boolean,
    isSentCarbon: boolean,
  ): boolean {
    const manager = this.deps.getE2EEManager?.()
    if (!manager) return false
    if (!stanzaHasE2EEClaim(stanza, manager)) return false
    void this.decryptAndReprocess(manager, stanza, isCarbonCopy, isSentCarbon)
    return true
  }

  private async decryptAndReprocess(
    manager: E2EEManager,
    stanza: Element,
    isCarbonCopy: boolean,
    isSentCarbon: boolean,
  ): Promise<void> {
    // Single helper covers every live shape (regular received, received
    // carbon, sent carbon): if `from` is our bare JID, the peer is the
    // recipient (`to`) and the plugin is told this is one of our own
    // outgoing messages being delivered back to us. Same rule MAM
    // applies on its archive entries — keeping the two paths aligned
    // through one function is what guards against the original bug.
    const ownBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const { peer, isSelfOutgoing } = deriveConversationContext(stanza, ownBareJid)
    await decryptStanzaInPlace(stanza, manager, peer, 'live', {
      isSelfOutgoing,
    })
    this.handleMessageInternal(stanza, isCarbonCopy, isSentCarbon)
  }

  /**
   * Read back the security context stashed on a stanza by
   * {@link decryptStanzaInPlace}. Returns `undefined` for stanzas that were
   * never claimed by a plugin (cleartext messages). The shape matches
   * {@link MessageSecurityContext} exactly; we narrow it here so downstream
   * consumers don't need to import from the e2ee module.
   */
  private readMessageSecurityContext(stanza: Element): MessageSecurityContext | undefined {
    const stash = readStashedSecurityContext(stanza)
    if (!stash) return undefined
    return {
      protocolId: stash.protocolId,
      trust: stash.trust,
      ...(stash.notes && { notes: stash.notes }),
    }
  }

  /**
   * Wrap an outbound 1:1 chat stanza with E2EE if a plugin can encrypt to
   * `recipient`. Mutates `children` in place: the existing `<body>` (if any)
   * is replaced with the plugin-supplied fallback string, and the encrypted
   * element + EME (XEP-0380) + MAM `<store>` hint (XEP-0334) are appended.
   *
   * Returns the {@link MessageSecurityContext} when encryption succeeded so
   * the caller can stamp it on the local store entry; returns `undefined`
   * when no manager is registered or no plugin matches the peer.
   *
   * Strict-mode contract: when a manager exists but no plugin can reach the
   * peer, throws {@link E2EEEncryptionRequiredError} instead of silently
   * letting the caller send plaintext. The UI is the only layer that can
   * legitimately decide to retry or to send unencrypted as a one-off, so
   * the error has to surface there. Other failures (probe errors, plugin
   * exceptions) are logged and treated as permissive — the caller's stanza
   * goes out as built.
   *
   * Centralizing this here is a security-critical invariant: every chat-like
   * outbound path (send, resend, correction, reaction reply-fallback) must
   * route through one helper, otherwise a code path can build cleartext
   * children and reach the wire without the E2EE rewrite. Adding a new
   * outgoing chat-like primitive? Call this helper before `sendStanza`.
   */
  /**
   * Wire-format URL for an encrypted file attachment: `aesgcm://…#IV+Key`.
   * Returns the attachment's plain HTTPS URL when `encryption` is absent.
   * Used for both the main OOB `<url/>` and the thumbnail `uri` attribute —
   * both live inside `<payload/>` when E2EE is active, so the key stays
   * protected end-to-end.
   */
  private attachmentWireUrl(
    httpsUrl: string,
    encryption: FileAttachment['encryption'] | undefined,
  ): string {
    if (!encryption) return httpsUrl
    return buildAesgcmUri({ httpsUrl, key: encryption.key, iv: encryption.iv })
  }

  private async applyE2EEToOutboundChat(
    recipient: string,
    plaintextBody: string,
    children: Element[],
    protectedChildKeys?: ReadonlySet<string>,
    options?: E2EEOutboundOptions,
  ): Promise<MessageSecurityContext | undefined> {
    const manager = this.deps.getE2EEManager?.()
    if (!manager) return undefined

    try {
      // Build the payload envelope: a `<payload xmlns='jabber:client'>`
      // carrying `<body/>` plus any stanza extensions the caller opted into
      // (via `protectedChildKeys`, each key formatted as "name|xmlns"). The
      // serialized form is the plaintext the plugin encrypts — wire format
      // is a minimal XEP-0373 payload subset per the XEP-0420 §9-aligned
      // policy (see docs/ENCRYPTION.md).
      //
      // Elements that MUST stay at stanza root (XEP-0334 hints, XEP-0359
      // stanza ids, routing) are NOT in `protectedChildKeys`: only keys in
      // that set move into the envelope. Unknown/new elements stay outside
      // by default — fail-safe for server-processed extensions.
      //
      // We compute which children would move but DON'T splice yet: if
      // encryption ends up not happening (no manager match, plugin error,
      // permissive policy) we want the outgoing stanza to look exactly
      // like the plaintext path would have built. Only commit the splice
      // after a successful encrypt.
      const encryptBody = options?.encryptBody ?? true
      const protectedChildren: Element[] = encryptBody ? [xml('body', {}, plaintextBody)] : []
      const protectedIndices: number[] = []
      if (protectedChildKeys && protectedChildKeys.size > 0) {
        for (let i = 0; i < children.length; i++) {
          const c = children[i]
          if (typeof c === 'string') continue
          const el = c as Element
          const key = `${el.name}|${el.attrs?.xmlns ?? ''}`
          if (protectedChildKeys.has(key)) {
            protectedChildren.push(el)
            protectedIndices.push(i)
          }
        }
      }
      // Body-less callers must contribute at least one protected child; an
      // empty envelope would encrypt nothing. Treat as "no encryption" so the
      // caller's plaintext stanza is sent untouched.
      if (protectedChildren.length === 0) {
        await manager.assertPlaintextPermitted({ kind: 'direct', peer: recipient })
        return undefined
      }
      const plaintext = serializePayloadEnvelope(protectedChildren)

      const result = await manager.encryptOutbound(
        { kind: 'direct', peer: recipient },
        new TextEncoder().encode(plaintext),
      )
      if (result) {
        // Commit: remove the now-encrypted children from the stanza root,
        // walking in reverse so earlier indices stay valid.
        for (let i = protectedIndices.length - 1; i >= 0; i--) {
          children.splice(protectedIndices[i], 1)
        }
        // Remove <fallback for="NS_OOB"> (and any other fallback whose feature
        // just moved into the encrypted payload). Leaving them would let the
        // XMPP server infer that an attachment was sent — the `for` attribute
        // names the feature namespace, which is now confidential.
        if (protectedIndices.length > 0 && protectedChildKeys) {
          const protectedNamespaces = new Set(
            [...protectedChildKeys].map(key => key.split('|')[1]).filter(ns => ns.length > 0),
          )
          for (let i = children.length - 1; i >= 0; i--) {
            const c = children[i]
            if (typeof c === 'string') continue
            const el = c as Element
            if (
              el.name === 'fallback' &&
              el.attrs?.xmlns === NS_FALLBACK &&
              protectedNamespaces.has(el.attrs?.for)
            ) {
              children.splice(i, 1)
            }
          }
        }
        const bodyIdx = children.findIndex(
          (c): c is Element =>
            typeof c !== 'string' && (c as { name?: string }).name === 'body',
        )
        if ((options?.outerBody ?? 'fallback') === 'remove') {
          if (bodyIdx >= 0) children.splice(bodyIdx, 1)
        } else {
          const fallbackBody = result.payload.fallbackBody ?? '[encrypted message]'
          if (bodyIdx >= 0) {
            children[bodyIdx] = xml('body', {}, fallbackBody)
          } else {
            children.unshift(xml('body', {}, fallbackBody))
          }
        }
        children.push(dataToElement(result.payload.stanzaElement))
        children.push(
          xml('encryption', {
            xmlns: NS_EME,
            namespace:
              result.payload.stanzaElement.attrs.xmlns ?? result.payload.protocolId,
          }),
        )
        const storeHint = options?.storeHint ?? 'store'
        if (storeHint !== 'none') {
          children.push(xml(storeHint, { xmlns: NS_HINTS }))
        }
        return {
          protocolId: result.plugin.descriptor.id,
          trust: 'verified',
        }
      }
      // No plugin matched — delegate the policy decision to the manager so
      // all rules (strict mode, verified-peer, forced-plaintext override)
      // live in one place.
      await manager.assertPlaintextPermitted({ kind: 'direct', peer: recipient })
    } catch (err) {
      if (err instanceof E2EEEncryptionRequiredError) throw err
      // A plugin was selected (selectStrategy returned non-null) and a
      // mid-flight failure occurred (openConversation, encrypt, or similar
      // — all run inside encryptOutbound and surface here). This is
      // NOT a policy question: encryption was expected for this peer, so we
      // must never silently downgrade to plaintext — pin-mismatch, key-locked
      // and own-key-conflict all surface here, and leaking the body at the
      // exact moment tampering is suspected is the worst outcome. Re-throw so
      // the UI can prompt to unlock / verify / resolve. A forced-plaintext
      // conversation selects no plugin and never reaches this catch.
      logWarn(
        `E2EE encrypt failed for ${recipient}, blocking plaintext send: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
    return undefined
  }

  /**
   * Keys of stanza extension children that should ride inside the OpenPGP
   * `<payload/>` when E2EE is on, per the XEP-0420 §9-aligned policy
   * documented in docs/ENCRYPTION.md. Each key is `"<name>|<xmlns>"` so
   * element names ambiguous across namespaces (like `<x/>`) resolve
   * precisely. Kept as a tight allowlist so new extensions default to
   * "outside the envelope" until explicitly added — fail-safe for
   * server-processed elements (XEP-0334 hints, XEP-0359 stanza ids).
   *
   * Current scope: XEP-0066 OOB + XEP-0446 file-metadata — both of which
   * carry file URL / filename / size / mimetype that would otherwise leak
   * to the XMPP server. This set is only for extensions that ride alongside
   * a message body. Standalone signal stanzas are encrypted by their own
   * send methods via their own key sets (E2EE_REACTION_KEYS,
   * E2EE_RETRACT_KEYS, E2EE_FASTEN_KEYS, E2EE_EASTER_EGG_KEYS) and LMC is
   * handled inline in sendCorrection. Chat states (XEP-0085) remain
   * plaintext by explicit product decision (see docs/ENCRYPTION.md).
   */
  private static readonly E2EE_PROTECTED_CHILD_KEYS: ReadonlySet<string> =
    new Set([`x|${NS_OOB}`, `file|${NS_FILE_METADATA}`])

  /** XEP-0444 reactions ride inside the envelope; the reacted-to id rides with them. */
  private static readonly E2EE_REACTION_KEYS: ReadonlySet<string> = new Set([
    `reactions|${NS_REACTIONS}`,
  ])

  /** XEP-0424 retract element rides inside the envelope; the retracted id rides with it. */
  private static readonly E2EE_RETRACT_KEYS: ReadonlySet<string> = new Set([
    `retract|${NS_RETRACT}`,
  ])

  /** XEP-0422 OGP fastening rides inside the envelope (hides url/title/description/image). */
  private static readonly E2EE_FASTEN_KEYS: ReadonlySet<string> = new Set([
    `apply-to|${NS_FASTEN}`,
  ])

  /** Fluux easter-egg animation rides inside the envelope. */
  private static readonly E2EE_EASTER_EGG_KEYS: ReadonlySet<string> = new Set([
    `easter-egg|${NS_EASTER_EGG}`,
  ])

  // --- Chat Methods (Outgoing) ---

  /**
   * Send a message to a user or room.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param body - Message text content
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   * @param replyTo - Optional reply information for threaded replies (XEP-0461)
   * @param references - Optional mention references (XEP-0372)
   * @param attachment - Optional file attachment (XEP-0066, XEP-0264)
   * @returns The message ID
   *
   * @example Simple message
   * ```typescript
   * const msgId = await client.chat.sendMessage('user@example.com', 'Hello!')
   * ```
   *
   * @example Message with attachment
   * ```typescript
   * const msgId = await client.chat.sendMessage('user@example.com', 'Check this out', 'chat', undefined, undefined, {
   *   url: 'https://example.com/file.pdf',
   *   name: 'document.pdf',
   *   size: 12345,
   *   mimeType: 'application/pdf'
   * })
   * ```
   */
  async sendMessage(
    to: string,
    body: string,
    type: 'chat' | 'groupchat' = 'chat',
    replyTo?: { id: string; to?: string; fallback?: { author: string; body: string } },
    references?: MentionReference[],
    attachment?: FileAttachment
  ): Promise<string> {
    const id = generateUUID()
    const recipient = type === 'chat' ? getBareJid(to) : to

    let fullBody = body
    let fallbackEnd = 0
    if (replyTo?.fallback) {
      const quotedLines = replyTo.fallback.body.split('\n').map(line => `> ${line}`).join('\n')
      const fallbackText = `> ${replyTo.fallback.author} wrote:\n${quotedLines}\n`
      fallbackEnd = fallbackText.length
      fullBody = fallbackText + body
    }

    // XEP-0066/XEP-0428: When sending an attachment, include the URL in the body
    // as fallback for non-supporting clients. Only the URL portion is marked as
    // fallback, so user text is preserved when received.
    let oobFallbackStart = 0
    let oobFallbackEnd = 0
    if (attachment) {
      if (fullBody.length === 0 || fullBody === attachment.url) {
        // No user text, or user explicitly typed the URL - use URL as body
        fullBody = attachment.url
        oobFallbackStart = 0
      } else {
        // User has text - append URL after a newline
        oobFallbackStart = fullBody.length + 1 // +1 for newline
        fullBody = fullBody + '\n' + attachment.url
      }
      oobFallbackEnd = fullBody.length
    }

    const children = [
      xml('body', {}, fullBody),
      xml('active', { xmlns: NS_CHATSTATES })
    ]

    if (replyTo) {
      // For MUC, prefer stanzaId (server-assigned, stable) for the reply reference
      const replyReferenceId = this.getMessageReferenceId(to, replyTo.id, type)
      const replyAttrs: Record<string, string> = { xmlns: NS_REPLY, id: replyReferenceId }
      if (replyTo.to) replyAttrs.to = replyTo.to
      children.push(xml('reply', replyAttrs))

      if (replyTo.fallback) {
        children.push(
          xml('fallback', { xmlns: NS_FALLBACK, for: NS_REPLY },
            xml('body', { start: '0', end: String(fallbackEnd) })
          )
        )
      }
    }

    if (references && references.length > 0) {
      let hasMentionAll = false
      for (const ref of references) {
        children.push(xml('reference', {
          xmlns: NS_REFERENCE,
          begin: ref.begin.toString(),
          end: ref.end.toString(),
          type: ref.type,
          uri: ref.uri,
        }))
        if (!ref.uri.includes('/')) hasMentionAll = true
      }
      if (hasMentionAll) children.push(xml('mention-all', { xmlns: NS_MENTION_ALL }))
    }

    if (attachment) {
      const oobUrl = this.attachmentWireUrl(attachment.url, attachment.encryption)
      const oobChildren = [xml('url', {}, oobUrl)]
      if (attachment.thumbnail) {
        const thumbUri = this.attachmentWireUrl(
          attachment.thumbnail.uri,
          attachment.thumbnail.encryption,
        )
        oobChildren.push(xml('thumbnail', {
          xmlns: NS_THUMBS,
          uri: thumbUri,
          'media-type': attachment.thumbnail.mediaType,
          width: String(attachment.thumbnail.width),
          height: String(attachment.thumbnail.height),
        }))
      }
      children.push(xml('x', { xmlns: NS_OOB }, ...oobChildren))
      // Mark only the URL portion as fallback (preserves user text)
      children.push(xml('fallback', { xmlns: NS_FALLBACK, for: NS_OOB },
        xml('body', { start: String(oobFallbackStart), end: String(oobFallbackEnd) })
      ))

      // XEP-0446: File Metadata Element (for original dimensions)
      const fileChildren: Element[] = []
      if (attachment.mediaType) {
        fileChildren.push(xml('media-type', {}, attachment.mediaType))
      }
      if (attachment.name) {
        fileChildren.push(xml('name', {}, attachment.name))
      }
      if (attachment.size !== undefined) {
        fileChildren.push(xml('size', {}, String(attachment.size)))
      }
      if (attachment.width !== undefined) {
        fileChildren.push(xml('width', {}, String(attachment.width)))
      }
      if (attachment.height !== undefined) {
        fileChildren.push(xml('height', {}, String(attachment.height)))
      }
      if (fileChildren.length > 0) {
        children.push(xml('file', { xmlns: NS_FILE_METADATA }, ...fileChildren))
      }
    }

    // XEP-0359: Include origin-id for echo deduplication
    children.push(createOriginIdElement(id))

    // E2EE hook: for 1:1 recipients, attempt to encrypt and rewrite the
    // outgoing children. MUC encryption is a later phase. Pass the
    // allowlist so XEP-0066 OOB + XEP-0446 file-metadata move inside the
    // encrypted `<payload/>` when E2EE is active (XEP-0420 §9-aligned
    // policy).
    const outgoingSecurityContext =
      type === 'chat'
        ? await this.applyE2EEToOutboundChat(
            recipient,
            fullBody,
            children,
            Chat.E2EE_PROTECTED_CHILD_KEYS,
          )
        : undefined

    // Guard: an encrypted attachment's aesgcm:// OOB URL carries the AES
    // key. If stanza-level E2EE didn't move that element into the payload,
    // the key reaches the server in cleartext — abort rather than leak.
    if (attachment?.encryption && !outgoingSecurityContext) {
      throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
    }

    const message = xml('message', { to: recipient, type, id }, ...children)
    await this.deps.sendStanza(message)

    if (type === 'chat') {
      // SDK events only - bindings call store methods
      this.deps.emitSDK('chat:typing', { conversationId: to, jid: to, isTyping: false })
      const message: Message = {
        type: 'chat',
        id,
        originId: id,
        conversationId: to,
        from: this.deps.getCurrentJid()!,
        // Store user's original text (empty if they only sent a file with no caption)
        // The URL in fullBody is fallback for non-OOB clients, not the user's message
        body: body === attachment?.url ? '' : body,
        timestamp: new Date(),
        isOutgoing: true,
        ...(replyTo && { replyTo: { id: replyTo.id, to: replyTo.to } }),
        ...(attachment && { attachment }),
        ...(outgoingSecurityContext && { securityContext: outgoingSecurityContext }),
      }
      this.deps.emitSDK('chat:message', { message })
    }

    return id
  }

  /**
   * XEP-0045 §7.5: send a private message ("whisper") to a single room
   * occupant. Unlike {@link sendMessage}, this preserves the `/nick`
   * resource (sendMessage strips it for type='chat') and emits `room:whisper`
   * instead of `chat:message` so the message is tracked as a private room
   * message rather than a 1:1 conversation. The XEP-0334 `<no-store>` hint
   * keeps it off the server archive; it is still persisted locally.
   *
   * @param roomJid bare room JID, e.g. 'room@conference.example.com'
   * @param nick    target occupant's nickname
   * @param body    message text
   * @returns the generated message id
   */
  async sendWhisper(roomJid: string, nick: string, body: string): Promise<string> {
    const id = generateUUID()
    const to = `${roomJid}/${nick}`

    const message = xml('message', { to, type: 'chat', id },
      xml('body', {}, body),
      xml('active', { xmlns: NS_CHATSTATES }),
      xml('x', { xmlns: NS_MUC_USER }),
      createOriginIdElement(id),
      xml('no-store', { xmlns: NS_HINTS }),
    )
    await this.deps.sendStanza(message)

    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room) logWarn(`sendWhisper: room ${roomJid} not found in store — sender nick will be empty`)
    const ourNick = room?.nickname || ''
    // Counterpart's stable occupant-id (XEP-0421), resolved from the live occupant
    // list, so a persisted thread can be re-bound to the same person later.
    const targetOccupantId = room?.occupants.get(nick)?.occupantId
    const whisper: RoomMessage = {
      type: 'groupchat',
      id,
      originId: id,
      roomJid,
      from: `${roomJid}/${ourNick}`,
      nick: ourNick,
      body,
      timestamp: new Date(),
      isOutgoing: true,
      isPrivate: true,
      whisperWith: nick,
      ...(targetOccupantId && { whisperWithOccupantId: targetOccupantId }),
    }
    this.deps.emitSDK('room:whisper', {
      roomJid,
      message: whisper,
      incrementUnread: false,
      incrementMentions: false,
    })
    return id
  }

  /**
   * Resend a previously failed message.
   *
   * Re-creates the message stanza from stored message data and sends it
   * without emitting a new `chat:message` event (the message already
   * exists in the store). The caller should clear the `deliveryError`
   * on the message before calling this.
   *
   * @param to - Recipient bare JID
   * @param body - Message body text
   * @param messageId - The original message ID to reuse
   * @param attachment - Optional file attachment to re-include
   */
  async resendMessage(
    to: string,
    body: string,
    messageId: string,
    attachment?: FileAttachment
  ): Promise<void> {
    const recipient = getBareJid(to)

    let fullBody = body
    // Reconstruct OOB fallback if attachment present
    let oobFallbackStart = 0
    let oobFallbackEnd = 0
    if (attachment) {
      if (fullBody.length === 0 || fullBody === attachment.url) {
        fullBody = attachment.url
        oobFallbackStart = 0
      } else {
        oobFallbackStart = fullBody.length + 1
        fullBody = fullBody + '\n' + attachment.url
      }
      oobFallbackEnd = fullBody.length
    }

    const children = [
      xml('body', {}, fullBody),
      xml('active', { xmlns: NS_CHATSTATES })
    ]

    if (attachment) {
      const oobUrl = this.attachmentWireUrl(attachment.url, attachment.encryption)
      const oobChildren = [xml('url', {}, oobUrl)]
      if (attachment.thumbnail) {
        const thumbUri = this.attachmentWireUrl(
          attachment.thumbnail.uri,
          attachment.thumbnail.encryption,
        )
        oobChildren.push(xml('thumbnail', {
          xmlns: NS_THUMBS,
          uri: thumbUri,
          'media-type': attachment.thumbnail.mediaType,
          width: String(attachment.thumbnail.width),
          height: String(attachment.thumbnail.height),
        }))
      }
      children.push(xml('x', { xmlns: NS_OOB }, ...oobChildren))
      children.push(xml('fallback', { xmlns: NS_FALLBACK, for: NS_OOB },
        xml('body', { start: String(oobFallbackStart), end: String(oobFallbackEnd) })
      ))
    }

    children.push(createOriginIdElement(messageId))

    // Same E2EE rewrite as the original sendMessage path. Without this a
    // failed encrypted send would retry as plaintext, leaking the body to
    // the server and onward to the recipient. Strict mode bubbles the
    // E2EEEncryptionRequiredError so the UI can decide what to do.
    const resendSecurityContext = await this.applyE2EEToOutboundChat(
      recipient,
      fullBody,
      children,
      Chat.E2EE_PROTECTED_CHILD_KEYS,
    )
    if (attachment?.encryption && !resendSecurityContext) {
      throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
    }

    const message = xml('message', { to: recipient, type: 'chat', id: messageId }, ...children)
    await this.deps.sendStanza(message)
  }

  /**
   * Send a chat state notification (typing indicator).
   *
   * Implements XEP-0085 Chat State Notifications to inform the other party
   * whether you are typing, have paused, or have gone away.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param state - The chat state to send
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   *
   * @example
   * ```typescript
   * // User started typing
   * await client.chat.sendChatState('user@example.com', 'composing')
   *
   * // User paused typing
   * await client.chat.sendChatState('user@example.com', 'paused')
   *
   * // User is active in the conversation
   * await client.chat.sendChatState('user@example.com', 'active')
   * ```
   *
   * @remarks
   * - For 1:1 chats, state is not sent if the contact is offline
   * - Common states: 'composing' (typing), 'paused' (stopped typing),
   *   'active' (focused), 'inactive' (not focused), 'gone' (left)
   */
  async sendChatState(to: string, state: ChatStateNotification, type: 'chat' | 'groupchat' = 'chat'): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to

    if (type === 'chat') {
      const contact = this.deps.stores?.roster.getContact(recipient)
      if (contact?.presence === 'offline') return
    }

    const message = xml('message', { to: recipient, type }, xml(state, { xmlns: NS_CHATSTATES }))
    await this.deps.sendStanza(message)
  }

  /**
   * Send or update reactions on a message (XEP-0444).
   *
   * Reactions allow users to respond to messages with emoji without sending
   * a full reply. Sending a new set of reactions replaces any previous
   * reactions from this user on the same message.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param messageId - The ID of the message to react to
   * @param emojis - Array of emoji characters (empty array removes reactions)
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   *
   * @example
   * ```typescript
   * // Add reactions to a message
   * await client.chat.sendReaction('user@example.com', 'msg-123', ['👍', '❤️'])
   *
   * // Remove all your reactions from a message
   * await client.chat.sendReaction('user@example.com', 'msg-123', [])
   *
   * // React in a MUC room
   * await client.chat.sendReaction('room@conference.example.com', 'msg-456', ['🎉'], 'groupchat')
   * ```
   */
  async sendReaction(to: string, messageId: string, emojis: string[], type: 'chat' | 'groupchat' = 'chat'): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to

    // For MUC, prefer stanzaId (server-assigned, stable) over client-generated id
    // Other clients (e.g. Gajim) reference messages by stanzaId in reactions
    const referenceId = this.getMessageReferenceId(to, messageId, type)

    const reactionElements = emojis.map(emoji => xml('reaction', {}, emoji))

    // XEP-0444: send a bodiless <reactions> stanza. We intentionally do NOT
    // attach a reply-quote body, a <reply> element, or <fallback> markers —
    // compliant clients render <reactions> natively, and the legacy reply-quote
    // fallback surfaced reactions as quoted replies in other clients. Incoming
    // reply-quoted reactions are still rendered on the receive side. For 1:1
    // chats the reply-quote also leaked the decrypted original body in
    // cleartext; dropping it removes that exposure too.
    const children: Element[] = [
      xml('reactions', { xmlns: NS_REACTIONS, id: referenceId }, ...reactionElements),
    ]

    const manager = this.deps.getE2EEManager?.()
    let peerCanEncrypt = false
    if (type === 'chat' && manager) {
      peerCanEncrypt = await manager
        .canEncryptTo({ kind: 'direct', peer: recipient })
        .catch(() => false)
      // Strict mode refuses to put even a bodiless reaction on the wire in
      // cleartext when the peer should be reachable over E2EE.
      if (!peerCanEncrypt && manager.getSendPolicy() === 'strict') {
        throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
      }
    }

    const reactionStanzaId = generateUUID()
    children.push(createOriginIdElement(reactionStanzaId))

    // Encrypt the reactions element (and the id it references) for 1:1 chats
    // whenever the peer is E2EE-reachable. A mid-flight plugin failure throws
    // here, blocking a silent plaintext downgrade. The E2EE path adds its own
    // <store> hint; the plaintext path adds one below so the bodiless reaction
    // is still archived in MAM.
    if (type === 'chat' && peerCanEncrypt) {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_REACTION_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'store',
      })
    } else {
      children.push(xml('store', { xmlns: NS_HINTS }))
    }

    const message = xml('message', { to: recipient, type, id: reactionStanzaId }, ...children)
    await this.deps.sendStanza(message)

    // SDK events only - bindings call store methods
    // Use the original messageId for local store updates (store matches by both id and stanzaId)
    if (type === 'groupchat') {
      const room = this.deps.stores?.room.getRoom(to)
      if (room) this.deps.emitSDK('room:reactions', { roomJid: to, messageId, reactorNick: room.nickname, emojis })
    } else {
      const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
      if (myBareJid) this.deps.emitSDK('chat:reactions', { conversationId: to, messageId, reactorJid: myBareJid, emojis })
    }
  }

  /**
   * Send a message correction (edit) for a previously sent message (XEP-0308).
   *
   * Allows correcting typos or updating content in a message you previously sent.
   * The correction replaces the original message content while preserving the
   * message ID reference.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param originalMessageId - The ID of the message to correct
   * @param newBody - The corrected message text
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   * @param attachment - Optional replacement file attachment
   *
   * @example
   * ```typescript
   * // Correct a typo in a message
   * await client.chat.sendCorrection('user@example.com', 'msg-123', 'Fixed the typo')
   *
   * // Correct a message in a MUC room
   * await client.chat.sendCorrection('room@conference.example.com', 'msg-456', 'Updated content', 'groupchat')
   * ```
   *
   * @remarks
   * - Only the original sender can correct a message
   * - The original body is preserved in `originalBody` for display
   * - Corrected messages are marked with `isEdited: true`
   */
  async sendCorrection(to: string, originalMessageId: string, newBody: string, type: 'chat' | 'groupchat' = 'chat', attachment?: FileAttachment): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to

    // XEP-0308 (Last Message Correction) has NO group-chat carve-out — unlike
    // XEP-0461 replies, XEP-0444 reactions and XEP-0424 retractions, which all
    // switch to the server/MUC stanza-id. A correction MUST reference the id the
    // ORIGINAL SENDER assigned: the origin-id (XEP-0359) when present, otherwise
    // the message id. Referencing the stanza-id breaks correction matching on
    // compliant clients (they render the edit as a brand-new message).
    const original = type === 'groupchat'
      ? this.deps.stores?.room.getMessage(to, originalMessageId)
      : this.deps.stores?.chat.getMessage(to, originalMessageId)
    const referenceId = original?.originId ?? originalMessageId

    // Build the body text, preserving user text when there's an attachment
    let bodyText = newBody
    let oobFallbackStart = 0
    let oobFallbackEnd = 0
    if (attachment) {
      if (newBody.length === 0 || newBody === attachment.url) {
        // No user text, or user explicitly typed the URL - use URL as body
        bodyText = attachment.url
        oobFallbackStart = 0
      } else {
        // User has text - append URL after a newline
        oobFallbackStart = newBody.length + 1 // +1 for newline
        bodyText = newBody + '\n' + attachment.url
      }
      oobFallbackEnd = bodyText.length
    }

    // XEP-0308: send the corrected body verbatim alongside a <replace> marker.
    // We intentionally do NOT add a "[Corrected] " body prefix or a
    // <fallback for="urn:xmpp:message-correct:0"> indication — compliant
    // clients replace the original from <replace> alone, and the prefix
    // confused clients that don't strip the fallback. We still strip an
    // incoming "[Corrected] " prefix on the receive side (see fallbackRegistry).
    const children = [
      xml('body', {}, bodyText),
      xml('replace', { xmlns: NS_CORRECTION, id: referenceId }),
    ]

    if (attachment) {
      const oobUrl = this.attachmentWireUrl(attachment.url, attachment.encryption)
      const oobChildren = [xml('url', {}, oobUrl)]
      if (attachment.thumbnail) {
        const thumbUri = this.attachmentWireUrl(
          attachment.thumbnail.uri,
          attachment.thumbnail.encryption,
        )
        oobChildren.push(xml('thumbnail', {
          xmlns: NS_THUMBS, uri: thumbUri, 'media-type': attachment.thumbnail.mediaType,
          width: String(attachment.thumbnail.width), height: String(attachment.thumbnail.height)
        }))
      }
      children.push(xml('x', { xmlns: NS_OOB }, ...oobChildren))
      // Mark only the URL portion as OOB fallback (preserves user text)
      children.push(xml('fallback', { xmlns: NS_FALLBACK, for: NS_OOB },
        xml('body', { start: String(oobFallbackStart), end: String(oobFallbackEnd) })
      ))

      // XEP-0446: File Metadata Element (for original dimensions)
      const fileChildren: Element[] = []
      if (attachment.mediaType) fileChildren.push(xml('media-type', {}, attachment.mediaType))
      if (attachment.name) fileChildren.push(xml('name', {}, attachment.name))
      if (attachment.size !== undefined) fileChildren.push(xml('size', {}, String(attachment.size)))
      if (attachment.width !== undefined) fileChildren.push(xml('width', {}, String(attachment.width)))
      if (attachment.height !== undefined) fileChildren.push(xml('height', {}, String(attachment.height)))
      if (fileChildren.length > 0) {
        children.push(xml('file', { xmlns: NS_FILE_METADATA }, ...fileChildren))
      }
    }

    const correctionStanzaId = generateUUID()
    children.push(createOriginIdElement(correctionStanzaId))

    // Encrypt the corrected body for 1:1 chats. Without this an edit on
    // an encrypted conversation would push the plaintext correction to
    // the server. E2EE peers handle <replace> natively. MUC encryption
    // is a later phase.
    const correctionSecurityContext = type === 'chat'
      ? await this.applyE2EEToOutboundChat(
          recipient,
          bodyText,
          children,
          Chat.E2EE_PROTECTED_CHILD_KEYS,
        )
      : undefined
    if (attachment?.encryption && !correctionSecurityContext) {
      throw new E2EEEncryptionRequiredError({ kind: 'direct', peer: recipient })
    }

    await this.deps.sendStanza(xml('message', { to: recipient, type, id: correctionStanzaId }, ...children))

    // SDK events only - bindings call store methods. Reuses the original
    // message fetched above for the correction reference.
    if (original) {
      const updates = { body: newBody, isEdited: true, originalBody: original.originalBody ?? original.body, attachment }
      if (type === 'groupchat') {
        this.deps.emitSDK('room:message-updated', { roomJid: to, messageId: originalMessageId, updates })
      } else {
        this.deps.emitSDK('chat:message-updated', { conversationId: to, messageId: originalMessageId, updates })
      }
    }
  }

  /**
   * Retract (delete) a previously sent message (XEP-0424).
   *
   * Requests that the recipient remove the message from their view.
   * Note that this is a request - recipients may still have seen the
   * original message, and not all clients support retraction.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param originalMessageId - The ID of the message to retract
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   *
   * @example
   * ```typescript
   * // Retract a message
   * await client.chat.sendRetraction('user@example.com', 'msg-123')
   *
   * // Retract a message in a MUC room
   * await client.chat.sendRetraction('room@conference.example.com', 'msg-456', 'groupchat')
   * ```
   *
   * @remarks
   * - Only the original sender can retract a message
   * - Retracted messages are marked with `isRetracted: true` and `retractedAt`
   * - A fallback message is included for clients that don't support XEP-0424
   */
  async sendRetraction(to: string, originalMessageId: string, type: 'chat' | 'groupchat' = 'chat'): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to

    // For MUC, prefer stanzaId (server-assigned, stable) for the retraction reference
    const referenceId = this.getMessageReferenceId(to, originalMessageId, type)

    // XEP-0424: Message Retraction with fallback for non-supporting clients
    const fallbackBody = 'This person attempted to retract a previous message, but it\'s unsupported by your client.'

    const retractionStanzaId = generateUUID()
    const children: Element[] = [
      xml('body', {}, fallbackBody),
      xml('retract', { xmlns: NS_RETRACT, id: referenceId }),
      // XEP-0428: Mark the entire body as fallback
      xml('fallback', { xmlns: NS_FALLBACK, for: NS_RETRACT }),
      createOriginIdElement(retractionStanzaId),
    ]

    // Encrypt the retract element for 1:1 chats. On success the helper hides
    // the retraction (the English notice is replaced by the generic encrypted
    // fallback and the <fallback for=NS_RETRACT> is dropped); on a mid-flight
    // plugin failure it throws, blocking a silent plaintext downgrade. The
    // plaintext path (no plugin reachable, permissive) keeps the notice.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_RETRACT_KEYS, {
        encryptBody: false,
        outerBody: 'fallback',
        storeHint: 'store',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: retractionStanzaId }, ...children),
    )

    // SDK events only - optimistic update via bindings
    const retractedAt = new Date()
    const updates = { isRetracted: true, retractedAt }
    if (type === 'groupchat') {
      const originalMessage = this.deps.stores?.room.getMessage(to, originalMessageId)
      if (originalMessage) {
        this.deps.emitSDK('room:message-updated', { roomJid: to, messageId: originalMessageId, updates })
      }
    } else {
      const originalMessage = this.deps.stores?.chat.getMessage(to, originalMessageId)
      if (originalMessage) {
        this.deps.emitSDK('chat:message-updated', { conversationId: to, messageId: originalMessageId, updates })
      }
    }
  }

  /**
   * Send an easter egg animation to a conversation.
   *
   * Easter eggs are fun visual effects that can be triggered in conversations.
   * These are ephemeral and not stored in message history.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   * @param animation - The animation identifier (e.g., 'confetti', 'fireworks')
   *
   * @example
   * ```typescript
   * // Send confetti animation
   * await client.chat.sendEasterEgg('user@example.com', 'chat', 'confetti')
   *
   * // Send fireworks in a room
   * await client.chat.sendEasterEgg('room@conference.example.com', 'groupchat', 'fireworks')
   * ```
   *
   * @remarks
   * - Messages are sent with no-store hint (not archived)
   * - The animation is triggered locally immediately
   */
  async sendEasterEgg(to: string, type: 'chat' | 'groupchat', animation: string): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to
    const children: Element[] = [
      xml('no-store', { xmlns: NS_HINTS }),
      xml('easter-egg', { xmlns: NS_EASTER_EGG, animation }),
    ]

    // Encrypt the animation for 1:1 chats. storeHint:'none' keeps the
    // <no-store> we built; a mid-flight plugin failure throws.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_EASTER_EGG_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'none',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: generateUUID() }, ...children),
    )

    // SDK event only - binding calls store.triggerAnimation
    if (type === 'groupchat') {
      this.deps.emitSDK('room:animation', { roomJid: to, animation })
    } else {
      this.deps.emitSDK('chat:animation', { conversationId: to, animation })
    }
  }

  /**
   * Send a link preview (Open Graph metadata) for a message containing a URL.
   *
   * Attaches rich preview metadata (title, description, image) to a message
   * that contains a link. Uses XEP-0422 Message Fastening to attach the
   * preview to the original message.
   *
   * @param to - Recipient JID (user for chat, room for groupchat)
   * @param originalId - The ID of the message containing the URL
   * @param preview - Open Graph preview data
   * @param preview.url - The URL being previewed
   * @param preview.title - The page title
   * @param preview.description - The page description
   * @param preview.image - URL to the preview image
   * @param preview.siteName - The site name
   * @param type - Message type: 'chat' for 1:1, 'groupchat' for MUC
   *
   * @example
   * ```typescript
   * await client.chat.sendLinkPreview('user@example.com', 'msg-123', {
   *   url: 'https://example.com/article',
   *   title: 'Article Title',
   *   description: 'A brief description of the article',
   *   image: 'https://example.com/preview.jpg',
   *   siteName: 'Example Site'
   * })
   * ```
   *
   * @remarks
   * - Sent with no-store hint (not archived separately)
   * - Updates the local message with the preview immediately
   */
  async sendLinkPreview(to: string, originalId: string, preview: any, type: 'chat' | 'groupchat' = 'chat'): Promise<void> {
    const recipient = type === 'chat' ? getBareJid(to) : to
    const metaElements: Element[] = [
      xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:url', content: preview.url })
    ]
    if (preview.title) metaElements.push(xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:title', content: preview.title }))
    if (preview.description) metaElements.push(xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:description', content: preview.description }))
    if (preview.image) metaElements.push(xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:image', content: preview.image }))
    if (preview.siteName) metaElements.push(xml('meta', { xmlns: 'http://www.w3.org/1999/xhtml', property: 'og:site_name', content: preview.siteName }))

    const children: Element[] = [
      xml('apply-to', { xmlns: NS_FASTEN, id: originalId },
        xml('external', { xmlns: NS_FASTEN, name: 'ogp' }, ...metaElements)
      ),
      xml('no-store', { xmlns: NS_HINTS }),
    ]

    // Encrypt the fastening for 1:1 chats so OGP url/title/description/image
    // don't leak to the server. storeHint:'none' keeps the <no-store> we built
    // (encrypted or not); a mid-flight plugin failure throws, blocking a
    // silent plaintext downgrade.
    if (type === 'chat') {
      await this.applyE2EEToOutboundChat(recipient, '', children, Chat.E2EE_FASTEN_KEYS, {
        encryptBody: false,
        outerBody: 'remove',
        storeHint: 'none',
      })
    }

    await this.deps.sendStanza(
      xml('message', { to: recipient, type, id: generateUUID() }, ...children),
    )

    // SDK event only - binding calls store.updateMessage
    const updates = { linkPreview: preview }
    if (type === 'groupchat') {
      this.deps.emitSDK('room:message-updated', { roomJid: to, messageId: originalId, updates })
    } else {
      this.deps.emitSDK('chat:message-updated', { conversationId: to, messageId: originalId, updates })
    }
  }

  // --- MAM Methods (delegated to MAM module) ---

  /**
   * Query Message Archive Management (XEP-0313) for message history.
   *
   * Retrieves archived messages from the server for a specific conversation.
   * Supports pagination for loading older messages incrementally.
   *
   * @param options - Query options
   * @param options.with - The JID to fetch history with (conversation partner)
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   *
   * @example Fetch recent messages
   * ```typescript
   * const result = await client.chat.queryMAM({
   *   with: 'user@example.com',
   *   max: 50
   * })
   * console.log(`Fetched ${result.messages.length} messages, complete: ${result.complete}`)
   * ```
   *
   * @example Load older messages (pagination)
   * ```typescript
   * // Initial load
   * const initial = await client.chat.queryMAM({ with: 'user@example.com' })
   *
   * // Load more (older messages)
   * if (!initial.complete && initial.rsm?.first) {
   *   const older = await client.chat.queryMAM({
   *     with: 'user@example.com',
   *     before: initial.rsm.first
   *   })
   * }
   * ```
   *
   * @remarks
   * - Messages are automatically merged into the chat store
   * - Handles corrections and retractions within the MAM results
   * - Sets loading state in the store during the query
   */
  async queryMAM(options: MAMQueryOptions): Promise<MAMResult> {
    return this.mamModule.queryArchive(options)
  }

  /**
   * Query Message Archive Management (XEP-0313) for a MUC room's message history.
   *
   * Retrieves archived messages from the room's archive. Supports pagination
   * for loading older messages incrementally.
   *
   * @param options - Query options
   * @param options.roomJid - The room JID to fetch history for
   * @param options.max - Maximum number of messages to retrieve (default: 50)
   * @param options.before - RSM cursor for pagination (empty string for latest, or message ID for older)
   * @returns Query result with messages, completion status, and pagination info
   *
   * @example Fetch recent room messages
   * ```typescript
   * const result = await client.chat.queryRoomMAM({
   *   roomJid: 'room@conference.example.com',
   *   max: 50
   * })
   * console.log(`Fetched ${result.messages.length} messages, complete: ${result.complete}`)
   * ```
   *
   * @remarks
   * - Room must support MAM (check via disco#info on room JID)
   * - Messages are automatically merged into the room store
   * - The room must be joined to fetch its MAM archive
   */
  async queryRoomMAM(options: RoomMAMQueryOptions): Promise<RoomMAMResult> {
    return this.mamModule.queryRoomArchive(options)
  }

  // --- Internal Message Processing (Migrated from MessageHandler) ---

  /**
   * Handle error-type messages (e.g., MUC invitation rejections, delivery failures).
   *
   * XMPP servers send `<message type="error">` when a stanza cannot be
   * delivered. The original message's `id` attribute is echoed back, letting
   * us correlate the error with the sent message.
   *
   * For MUC mediated invitations, the original `<x xmlns="muc#user">`
   * element is echoed back inside the error stanza, letting us detect the
   * specific failure and surface it to the UI.
   */
  private handleErrorMessage(stanza: Element, from: string): void {
    const bareFrom = from ? getBareJid(from) : undefined
    if (!bareFrom) return

    const error = parseXMPPError(stanza)
    if (!error) return

    // Check if this is a bounced MUC invitation
    const mucUser = stanza.getChild('x', NS_MUC_USER)
    const invite = mucUser?.getChild('invite')
    if (invite) {
      this.deps.emitSDK('room:invite-error', {
        roomJid: bareFrom,
        error: formatXMPPError(error),
        condition: error.condition,
        errorType: error.type,
      })
      return
    }

    // Chat message delivery error — correlate via the echoed message ID.
    // Skip 'recipient-unavailable': this means one resource went offline,
    // but the server already delivered the message to other available
    // resources. Marking the message as failed would be a false alarm.
    const messageId = stanza.attrs.id
    if (messageId && error.condition !== 'recipient-unavailable') {
      this.deps.emitSDK('chat:message-error', {
        conversationId: bareFrom,
        messageId,
        error,
      })
    }
  }

  private handleChatState(stanza: Element, fullFrom: string, bareFrom: string, _bareTo?: string, type?: string): void {
    const state = ['active', 'composing', 'paused', 'inactive', 'gone'].find(s => !!stanza.getChild(s, NS_CHATSTATES)) as ChatStateNotification | undefined
    if (!state) return

    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isTyping = state === 'composing'

    if (type === 'groupchat') {
      // MUC room: emit room:typing with the nickname
      const nick = getResource(fullFrom)
      if (!nick) return

      // Don't show our own typing indicator in MUC rooms
      const room = this.deps.stores?.room.getRoom(bareFrom)
      if (room && room.nickname.toLowerCase() === nick.toLowerCase()) return

      this.deps.emitSDK('room:typing', { roomJid: bareFrom, nick, isTyping })
    } else {
      // 1:1 chat: emit chat:typing
      // Ignore our own typing state (e.g., from carbon copies)
      if (bareFrom === myBareJid) return
      this.deps.emitSDK('chat:typing', { conversationId: bareFrom, jid: bareFrom, isTyping })
    }
  }

  /**
   * Get the best message ID for referencing in protocol stanzas (reactions, etc.).
   * For MUC, prefers the server-assigned stanzaId since it is the canonical, stable
   * identifier that other clients will also reference.
   */
  private getMessageReferenceId(entityId: string, messageId: string, type: 'chat' | 'groupchat'): string {
    // Per XEP-0461: only groupchat messages should use stanza-id for reply references.
    // Chat-type messages must use the message id or origin-id.
    if (type === 'groupchat') {
      const msg = this.deps.stores?.room.getMessage(entityId, messageId)
      if (msg?.stanzaId) return msg.stanzaId
    }
    return messageId
  }

  private handleIncomingReaction(stanza: Element, reactionsEl: Element, from: string, bareFrom: string, bareTo: string | undefined, type: string, isSentCarbon: boolean): void {
    const messageId = reactionsEl.attrs.id
    if (!messageId) return

    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = isSentCarbon || bareFrom === myBareJid
    const conversationId = isOutgoing ? bareTo : bareFrom
    if (!conversationId) return

    const emojiElements = reactionsEl.getChildren('reaction')
    const emojis = emojiElements.map(el => el.getText()).filter(Boolean) as string[]

    // Extract XEP-0203 delay timestamp if present (offline-queued or replayed reactions).
    const delayEl = stanza.getChild('delay', NS_DELAY)
    const stamp = delayEl?.attrs.stamp
    const timestamp = stamp ? new Date(stamp) : undefined

    // SDK events only - bindings call store methods
    if (type === 'groupchat') {
      const roomNick = getResource(from)
      if (roomNick) {
        this.deps.emitSDK('room:reactions', { roomJid: conversationId, messageId, reactorNick: roomNick, emojis, ...(timestamp && { timestamp }) })
      }
    } else {
      this.deps.emitSDK('chat:reactions', { conversationId, messageId, reactorJid: bareFrom, emojis, ...(timestamp && { timestamp }) })
    }
  }

  private handleFastening(applyToEl: Element, bareFrom: string, bareTo: string | undefined, type: string, isSentCarbon: boolean): void {
    const messageId = applyToEl.attrs.id
    if (!messageId) return

    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = isSentCarbon || bareFrom === myBareJid
    const conversationId = isOutgoing ? bareTo : bareFrom
    if (!conversationId) return

    const linkPreview = parseOgpFastening(applyToEl)
    if (linkPreview) {
      // SDK event only - binding calls store.updateMessage
      if (type === 'groupchat') {
        this.deps.emitSDK('room:message-updated', { roomJid: conversationId, messageId, updates: { linkPreview } })
      } else {
        this.deps.emitSDK('chat:message-updated', { conversationId, messageId, updates: { linkPreview } })
      }
    }
  }

  /**
   * XEP-0421: in a MUC the occupant-id is the stable, unforgeable author
   * identity — the full room JID is nick-based and a nick can be reassigned to
   * a different occupant once the author leaves. Prefer occupant-id when BOTH
   * the stored message and the incoming stanza carry one; otherwise fall back to
   * the full MUC JID (older servers / no XEP-0421 support). XEP-0424 mandates
   * this occupant-id check for retractions; we apply the same gate to corrections.
   */
  private isSameMucAuthor(original: RoomMessage, from: string, senderOccupantId: string | undefined): boolean {
    if (original.occupantId && senderOccupantId) {
      return original.occupantId === senderOccupantId
    }
    return original.from === from
  }

  private handleIncomingCorrection(stanza: Element, originalId: string, from: string, bareFrom: string, bareTo: string | undefined, body: string, type: string, isSentCarbon: boolean): boolean {
    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = isSentCarbon || bareFrom === myBareJid
    const conversationId = isOutgoing ? bareTo : bareFrom
    if (!conversationId) return false

    // Capture the correction stanza's own stanza-id so replies referencing
    // the corrected version's archive entry can resolve to the original message
    const correctionStanzaId = parseStanzaId(stanza)

    // SDK events only - bindings call store methods
    if (type === 'groupchat') {
      const original = this.deps.stores?.room.getMessage(conversationId, originalId)
      const senderOccupantId = stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id
      if (original && this.isSameMucAuthor(original, from, senderOccupantId)) {
        const correctionData = applyCorrection(stanza, body, original.originalBody ?? original.body)
        if (correctionStanzaId) {
          correctionData.correctionStanzaIds = [...(original.correctionStanzaIds ?? []), correctionStanzaId]
        }
        this.deps.emitSDK('room:message-updated', { roomJid: conversationId, messageId: originalId, updates: correctionData })
        return true
      }
    } else {
      const original = this.deps.stores?.chat.getMessage(conversationId, originalId)
      if (original && original.from === bareFrom) {
        const correctionData = applyCorrection(stanza, body, original.originalBody ?? original.body)
        if (correctionStanzaId) {
          correctionData.correctionStanzaIds = [...(original.correctionStanzaIds ?? []), correctionStanzaId]
        }
        this.deps.emitSDK('chat:message-updated', { conversationId, messageId: originalId, updates: correctionData })
        return true
      }
    }
    return false
  }

  private handleIncomingRetraction(originalId: string, from: string, bareFrom: string, bareTo: string | undefined, type: string, isSentCarbon: boolean, senderOccupantId?: string): boolean {
    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = isSentCarbon || bareFrom === myBareJid
    const conversationId = isOutgoing ? bareTo : bareFrom
    if (!conversationId) return false

    // SDK events only - bindings call store methods
    if (type === 'groupchat') {
      const original = this.deps.stores?.room.getMessage(conversationId, originalId)
      const retractionData = applyRetraction(!!original && this.isSameMucAuthor(original, from, senderOccupantId))
      if (retractionData) {
        this.deps.emitSDK('room:message-updated', { roomJid: conversationId, messageId: originalId, updates: retractionData })
        return true
      }
    } else {
      const original = this.deps.stores?.chat.getMessage(conversationId, originalId)
      const retractionData = applyRetraction(!!original && original.from === bareFrom)
      if (retractionData) {
        this.deps.emitSDK('chat:message-updated', { conversationId, messageId: originalId, updates: retractionData })
        return true
      }
    }
    return false
  }

  /**
   * Handle incoming XEP-0425 moderation broadcast from the room service.
   *
   * Supports multiple stanza formats:
   * - v0: `<apply-to id="..."><moderated by="..." xmlns="...:0">` (stanza-id on apply-to)
   * - v1: `<retract id="..."><moderated by="..." xmlns="...:1">` (stanza-id on retract)
   * - legacy: `<moderated id="..." by="...">` (stanza-id on moderated itself)
   *
   * @param stanzaId - The stanza-id of the retracted message (from wrapper element)
   * @param moderatedEl - The `<moderated>` element containing the moderator info
   */
  private handleIncomingModeration(stanzaId: string, moderatedEl: Element, bareFrom: string, type: string): boolean {
    // XEP-0425 moderation only applies to groupchat messages
    if (type !== 'groupchat') return false

    // Extract moderator nick from the "by" attribute (full MUC JID: room@server/nick)
    const byJid = moderatedEl.attrs.by
    const moderatedBy = byJid ? getResource(byJid) : undefined

    // Extract optional reason
    const reason = moderatedEl.getChildText('reason') || undefined

    this.deps.emitSDK('room:message-updated', {
      roomJid: bareFrom,
      messageId: stanzaId,
      updates: {
        isRetracted: true,
        retractedAt: new Date(),
        isModerated: true,
        moderatedBy,
        moderationReason: reason,
      },
    })
    return true
  }

  private handleMucInvitation(stanza: Element, from: string): boolean {
    // Direct Invitation (XEP-0249)
    // For direct invitations, quickchat marker is a sibling of <x> (message goes directly to invitee)
    const directInvite = stanza.getChild('x', NS_CONFERENCE)
    if (directInvite) {
      const roomJid = directInvite.attrs.jid
      if (roomJid) {
        // Detect quickchat from marker element OR fallback to JID naming pattern.
        // The fallback is needed because some MUC servers strip unknown namespaced elements
        // when forwarding invitations.
        const isQuickChat = !!stanza.getChild('quickchat', NS_FLUUX) || isQuickChatJid(roomJid)
        // SDK event only - binding calls store.addMucInvitation
        this.deps.emitSDK('events:muc-invitation', {
          roomJid,
          from,
          reason: directInvite.attrs.reason,
          password: directInvite.attrs.password,
          isDirect: true,
          isQuickChat,
        })
        return true
      }
    }

    // Mediated Invitation (XEP-0045)
    // For mediated invitations, quickchat marker is INSIDE the <invite> element
    // (so it gets forwarded by the MUC server)
    const mucUser = stanza.getChild('x', NS_MUC_USER)
    const invite = mucUser?.getChild('invite')
    if (invite) {
      const roomJid = from
      // Use inviter JID if present, otherwise fall back to room JID
      // (some servers may omit the from attribute)
      const inviteFrom = invite.attrs.from || roomJid
      const reason = invite.getChildText('reason') || undefined
      const password = mucUser?.getChildText('password') || undefined
      // Detect quickchat from marker element OR fallback to JID naming pattern.
      // The fallback is needed because some MUC servers strip unknown namespaced elements
      // when forwarding invitations.
      const isQuickChat = !!invite.getChild('quickchat', NS_FLUUX) || isQuickChatJid(roomJid)
      if (roomJid) {
        // SDK event only - binding calls store.addMucInvitation
        this.deps.emitSDK('events:muc-invitation', {
          roomJid,
          from: inviteFrom,
          reason,
          password,
          isDirect: false,
          isQuickChat,
        })
        return true
      }
    }

    return false
  }

  private processChatMessage(stanza: Element, _from: string, bareFrom: string, bareTo: string | undefined, body: string, isCarbonCopy: boolean, isSentCarbon: boolean): Message | null {
    const myBareJid = getBareJid(this.deps.getCurrentJid() ?? '')
    const isOutgoing = isSentCarbon || bareFrom === myBareJid
    const conversationId = isOutgoing ? bareTo : bareFrom
    if (!conversationId) return null

    // SDK event only - binding calls store.setTyping
    if (!isCarbonCopy) {
      this.deps.emitSDK('chat:typing', { conversationId, jid: bareFrom, isTyping: false })
    }

    const authoredAt = readStashedAuthoredAt(stanza)
    const parsed = parseMessageContent({
      messageEl: stanza,
      body,
      ...(authoredAt && { authoredAt }),
    })
    const isCorrection = !!stanza.getChild('replace', NS_CORRECTION)

    // For corrections whose target isn't in store: use the replace target ID
    // so subsequent corrections for the same original can find and update this message
    const replaceTargetId = isCorrection ? stanza.getChild('replace', NS_CORRECTION)?.attrs.id : undefined
    // Use stable ID for messages without ID (e.g., from IRC bridges) to enable deduplication
    const messageId = replaceTargetId || stanza.attrs.id || generateStableMessageId(bareFrom, parsed.timestamp, body)

    const securityContext = this.readMessageSecurityContext(stanza)
    const encryptedPayload = readStashedEncryptedPayload(stanza)
    const unsupportedEncryption = readStashedUnsupportedEncryption(stanza)
    const message: Message = {
      type: 'chat',
      id: messageId,
      ...(parsed.stanzaId && { stanzaId: parsed.stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
      conversationId,
      from: bareFrom,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      ...(parsed.isDelayed && { isDelayed: true }),
      ...(parsed.noStyling && { noStyling: true }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(isCorrection && { isEdited: true }),
      ...(securityContext && { securityContext }),
      ...(encryptedPayload && { encryptedPayload }),
      ...(unsupportedEncryption && { unsupportedEncryption }),
    }

    if (!isOutgoing && this.deps.stores) {
      // Skip stranger message handling for MUC JIDs - they should never be treated as contacts
      if (!this.deps.stores.roster.hasContact(conversationId) && !isMucJid(conversationId)) {
        // SDK event only - binding calls store.addStrangerMessage
        this.deps.emitSDK('events:stranger-message', { from: conversationId, body: parsed.processedBody })
        return message
      }
    }

    if (this.deps.stores && !this.deps.stores.chat.hasConversation(conversationId)) {
      const rosterContact = this.deps.stores.roster.getContact(conversationId)
      const conversation = { id: conversationId, name: rosterContact?.name || getLocalPart(conversationId), type: 'chat' as const, unreadCount: 0 }
      // SDK event only - binding calls store.addConversation
      this.deps.emitSDK('chat:conversation', { conversation })
    }

    // SDK event only - binding calls store.addMessage
    this.deps.emitSDK('chat:message', { message })
    return message
  }

  private processRoomMessage(stanza: Element, from: string, bareFrom: string, body: string, _isCarbonCopy: boolean, isSentCarbon: boolean): RoomMessage | null {
    const roomJid = bareFrom
    const nick = getResource(from) || ''
    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room) return null

    // Case-insensitive nickname comparison - some servers may change case
    const isOutgoing = isSentCarbon || (room.nickname.toLowerCase() === nick.toLowerCase())
    const roomAuthoredAt = readStashedAuthoredAt(stanza)
    const parsed = parseMessageContent({
      messageEl: stanza,
      body,
      preserveFullReplyToJid: true,
      messageContext: 'room',
      ...(roomAuthoredAt && { authoredAt: roomAuthoredAt }),
    })
    const isCorrection = !!stanza.getChild('replace', NS_CORRECTION)

    // For corrections whose target isn't in store: use the replace target ID
    // so subsequent corrections for the same original can find and update this message
    const replaceTargetId = isCorrection ? stanza.getChild('replace', NS_CORRECTION)?.attrs.id : undefined
    // Use stable ID for messages without ID (e.g., from IRC bridges) to enable deduplication
    const messageId = replaceTargetId || stanza.attrs.id || generateStableMessageId(from, parsed.timestamp, body)

    // XEP-0421: Anonymous Unique Occupant Identifiers
    const occupantId = stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id

    const securityContext = this.readMessageSecurityContext(stanza)
    const encryptedPayload = readStashedEncryptedPayload(stanza)
    const unsupportedEncryption = readStashedUnsupportedEncryption(stanza)
    const message: RoomMessage = {
      type: 'groupchat',
      id: messageId,
      ...(parsed.stanzaId && { stanzaId: parsed.stanzaId }),
      ...(parsed.originId && { originId: parsed.originId }),
      roomJid,
      from,
      nick,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      ...(parsed.isDelayed && { isDelayed: true }),
      ...(parsed.noStyling && { noStyling: true }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(isCorrection && { isEdited: true }),
      ...(occupantId && { occupantId }),
      ...(securityContext && { securityContext }),
      ...(encryptedPayload && { encryptedPayload }),
      ...(unsupportedEncryption && { unsupportedEncryption }),
    }

    // Poll detection: check for <poll> or <poll-closed> elements
    const pollEl = stanza.getChild('poll', NS_POLL)
    if (pollEl) {
      const pollData = parsePollElement(pollEl)
      if (pollData) {
        message.poll = pollData
        // Set creator ID from occupant-id if available
        if (occupantId) {
          message.poll.creatorId = occupantId
        }
      }
    }
    const pollClosedEl = stanza.getChild('poll-closed', NS_POLL)
    if (pollClosedEl) {
      const pollClosedData = parsePollClosedElement(pollClosedEl)
      if (pollClosedData) {
        // Verify against the original poll message (if available in store)
        const originalMsg = this.deps.stores?.room.getMessage(roomJid, pollClosedData.pollMessageId)
        if (originalMsg?.poll) {
          if (this.verifyPollClosed(pollClosedData, originalMsg, nick, occupantId)) {
            message.pollClosed = pollClosedData
            // Mark the original poll message as closed + reconcile reactions if voters present
            const closedUpdates: Partial<RoomMessage> = { pollClosedAt: message.timestamp }
            const closedReactions = this.buildReactionsFromResults(pollClosedData.results)
            if (closedReactions) closedUpdates.reactions = closedReactions
            this.deps.emitSDK('room:message-updated', {
              roomJid,
              messageId: pollClosedData.pollMessageId,
              updates: closedUpdates,
            })
          } else {
            logWarn(`Poll-closed rejected: verification failed for poll ${pollClosedData.pollMessageId} in ${roomJid}`)
          }
        } else {
          // Original poll not in store — accept on trust, then verify asynchronously via MAM
          message.pollClosed = pollClosedData
          this.deferredPollClosedVerification(roomJid, messageId, pollClosedData, nick, occupantId, message.timestamp)
        }
      }
    }

    // Mentions logic
    if (!isOutgoing) {
      const mentions = this.parseMentions(stanza)
      const isMention = checkForMention(parsed.processedBody, room.nickname)
      const isMentionAll = this.checkForMentionAll(parsed.processedBody, !!stanza.getChild('mention-all', NS_MENTION_ALL))
      
      if (isMention || isMentionAll) {
        message.isMention = true
        message.isMentionAll = isMentionAll
      }
      if (mentions.length > 0) message.mentions = mentions
    }

    // SDK event only - binding calls store.addMessage
    this.deps.emitSDK('room:message', {
      roomJid,
      message,
      incrementUnread: !message.isOutgoing,
      incrementMentions: message.isMention,
    })
    return message
  }

  /**
   * XEP-0045 §7.5: build a RoomMessage for an incoming/sent private message.
   * Mirrors the core of processRoomMessage but marks the message private
   * (persisted locally, kept off the server archive), and skips public-only
   * concerns (polls, public mention scanning). Emits `room:whisper`.
   */
  private processRoomWhisper(
    stanza: Element,
    from: string,
    bareFrom: string,
    body: string,
    isSentCarbon: boolean
  ): RoomMessage | null {
    const roomJid = bareFrom
    const nick = getResource(from) || ''
    const room = this.deps.stores?.room.getRoom(roomJid)
    if (!room) return null

    const isOutgoing = isSentCarbon || (room.nickname.toLowerCase() === nick.toLowerCase())
    const parsed = parseMessageContent({
      messageEl: stanza,
      body,
      preserveFullReplyToJid: true,
      messageContext: 'room',
    })
    const messageId = stanza.attrs.id || generateStableMessageId(from, parsed.timestamp, body)
    const occupantId = stanza.getChild('occupant-id', NS_OCCUPANT_ID)?.attrs.id

    // whisperWith is always the remote occupant: the sender for incoming, or
    // (rare sent-carbon case) the recipient derived from the `to` resource.
    const whisperWith = isOutgoing ? (getResource(stanza.attrs.to) || nick) : nick
    // Counterpart's stable occupant-id (XEP-0421): the sender's id for an incoming
    // whisper, or the recipient's (looked up by nick) for a sent-carbon echo.
    const whisperWithOccupantId = isOutgoing
      ? room.occupants.get(whisperWith)?.occupantId
      : occupantId

    const message: RoomMessage = {
      type: 'groupchat',
      id: messageId,
      ...(parsed.originId && { originId: parsed.originId }),
      roomJid,
      from,
      nick,
      body: parsed.processedBody,
      timestamp: parsed.timestamp,
      isOutgoing,
      isPrivate: true,
      whisperWith,
      ...(whisperWithOccupantId && { whisperWithOccupantId }),
      ...(parsed.isDelayed && { isDelayed: true }),
      ...(parsed.noStyling && { noStyling: true }),
      ...(parsed.replyTo && { replyTo: parsed.replyTo }),
      ...(parsed.attachment && { attachment: parsed.attachment }),
      ...(occupantId && { occupantId }),
    }

    // Design decision (spec §11): an incoming whisper is treated like a mention
    // for notification purposes — it bumps the room's mention counter.
    this.deps.emitSDK('room:whisper', {
      roomJid,
      message,
      incrementUnread: !isOutgoing,
      incrementMentions: !isOutgoing,
    })
    return message
  }

  /**
   * Verify a poll-closed message against the original poll data.
   * Checks creator identity, title match, and emoji validity.
   */
  private verifyPollClosed(
    pollClosed: PollClosedData,
    originalMsg: RoomMessage,
    senderNick: string,
    senderOccupantId?: string,
  ): boolean {
    if (!originalMsg.poll) return false
    // Verify the sender is the original poll creator
    const senderIsCreator = (senderOccupantId && originalMsg.occupantId)
      ? senderOccupantId === originalMsg.occupantId
      : senderNick === originalMsg.nick
    // Verify the title matches
    const titleMatches = pollClosed.title === originalMsg.poll.title
    // Verify result emojis are a subset of the original poll options
    const originalEmojis = new Set(originalMsg.poll.options.map(o => o.emoji))
    const emojisMatch = pollClosed.results.every(r => originalEmojis.has(r.emoji))
    return senderIsCreator && titleMatches && emojisMatch
  }

  /**
   * Build a reactions map from results that include voter lists.
   * Returns undefined if no voters are present in any result.
   */
  private buildReactionsFromResults(
    results: { emoji: string; voters?: string[] }[]
  ): Record<string, string[]> | undefined {
    const reactions: Record<string, string[]> = {}
    let hasVoters = false
    for (const r of results) {
      if (r.voters && r.voters.length > 0) {
        reactions[r.emoji] = [...r.voters]
        hasVoters = true
      }
    }
    return hasVoters ? reactions : undefined
  }

  /**
   * Asynchronously fetch the original poll via MAM and verify the poll-closed message.
   * If verification fails, remove pollClosed from the message via an update.
   */
  private deferredPollClosedVerification(
    roomJid: string,
    closeMsgId: string,
    pollClosed: PollClosedData,
    senderNick: string,
    senderOccupantId?: string,
    closedTimestamp?: Date,
  ): void {
    this.mamModule.fetchRoomMessageById(roomJid, pollClosed.pollMessageId).then((originalMsg) => {
      if (!originalMsg?.poll) return // MAM fetch failed or message has no poll — keep trust-based acceptance
      if (!this.verifyPollClosed(pollClosed, originalMsg, senderNick, senderOccupantId)) {
        logWarn(`Poll-closed rejected (deferred): verification failed for poll ${pollClosed.pollMessageId} in ${roomJid}`)
        // Verification failed — remove pollClosed from the message
        this.deps.emitSDK('room:message-updated', {
          roomJid,
          messageId: closeMsgId,
          updates: { pollClosed: undefined },
        })
      } else {
        // Verification passed — mark the original poll message as closed
        this.deps.emitSDK('room:message-updated', {
          roomJid,
          messageId: pollClosed.pollMessageId,
          updates: { pollClosedAt: closedTimestamp ?? new Date() },
        })
      }
    }).catch(() => {
      // MAM query failed — keep trust-based acceptance
    })
  }

  private parseMentions(stanza: Element): MentionReference[] {
    const refs = stanza.getChildren('reference', NS_REFERENCE)
    return refs.map(ref => ({
      begin: parseInt(ref.attrs.begin, 10),
      end: parseInt(ref.attrs.end, 10),
      type: ref.attrs.type as 'mention',
      uri: ref.attrs.uri,
    })).filter(ref => ref.type === 'mention')
  }

  private checkForMentionAll(body: string, hasMentionAllElement: boolean): boolean {
    return hasMentionAllElement || /@all\b/i.test(body)
  }
}
