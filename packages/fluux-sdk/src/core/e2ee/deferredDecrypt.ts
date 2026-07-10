/**
 * Deferred-decrypt engine.
 *
 * Repairs messages that were stored with an {@link Message.encryptedPayload}
 * because decryption failed at receive time — no E2EE plugin registered yet,
 * the private key was still locked, or a peer's key was not cached so the
 * signature could not be verified. When the blocking condition clears (plugin
 * registers, key unlocks, peer key arrives) the engine re-runs decryption over
 * the stashed payloads and commits the recovered plaintext / signals.
 *
 * This is a self-contained message-repair subsystem, not part of the client
 * facade. It reads and writes conversation state EXCLUSIVELY through the
 * injected {@link StoreBindings} and message-cache port — never the global
 * Zustand stores — so a consumer that supplies custom stores gets correct
 * behaviour. Its collaborators (E2EEManager, StoreBindings, own JID, cache)
 * are provided as getters because each is rebuilt over the client's lifetime
 * (the manager is `null` before login and rebuilt on identity change; stores
 * can be re-bound).
 */
import { xml, Element } from '@xmpp/client'
import * as ltx from 'ltx'
import type { E2EEManager } from '.'
import { decryptStanzaInPlace, COULD_NOT_DECRYPT_BODY, MESSAGE_REJECTED_BODY } from './stanzaDecrypt'
import { parseMessageContent, applyRetraction, parseReactionsSignal, parseRetractionSignal } from '../modules/messagingUtils'
import { getBareJid, getDomain } from '../jid'
import { logDebug, logInfo, logWarn } from '../logger'
import type { StoreBindings, MessageSecurityContext, FileAttachment, Message } from '../types'

/**
 * A bodiless signal stanza recovered from a deferred decrypt. The whole
 * element rode inside the encrypted payload (so the server never saw it), and
 * it has no `<body>` — it targets ANOTHER message rather than carrying content.
 * The placeholder "message" it was provisionally stored under must be replaced
 * by applying the signal to its target.
 */
type RetryModification =
  | { type: 'reactions'; targetId: string; emojis: string[] }
  | { type: 'retract'; targetId: string }

/**
 * Result of a single deferred-decrypt attempt.
 * - `decrypted`: plaintext recovered — update body/security/attachment, clear `encryptedPayload`.
 * - `modification`: decrypt surfaced a bodiless signal (XEP-0444 reaction or XEP-0424 retraction) —
 *   apply it to its target and remove the placeholder; there is no message body to update.
 * - `unsupported`: protocol we have no plugin for — clear `encryptedPayload`, tag `unsupportedEncryption`, keep body.
 * - `rejected`: signature is invalid (final, never retryable) — a real message placeholder is
 *   replaced with a "[Message rejected]" body; a bodiless-signal placeholder (forged reaction/
 *   retraction) is removed entirely so it never surfaces as a ghost bubble.
 * - `pending`: still cannot decrypt (key locked / plugin not ready) — leave `encryptedPayload`.
 */
type RetryOutcome =
  | { kind: 'decrypted'; body: string; securityContext?: MessageSecurityContext; attachment?: FileAttachment }
  | { kind: 'modification'; modification: RetryModification }
  | { kind: 'unsupported'; info: { namespace: string; name: string } }
  | { kind: 'rejected'; securityContext?: MessageSecurityContext }
  | { kind: 'pending' }

/**
 * Message-cache port — the durable IndexedDB slice the engine repairs for
 * conversations that are not loaded in memory. Injected so the engine has no
 * direct module-global dependency and is unit-testable in isolation.
 */
export interface DeferredDecryptCache {
  getMessagesWithEncryptedPayload: () => Promise<Message[]>
  updateMessage: (id: string, updates: Partial<Message>) => Promise<void>
  deleteMessage: (id: string) => Promise<void>
}

/**
 * Explicit collaborators for {@link DeferredDecryptEngine}. All stateful
 * dependencies are getters so the engine always observes the current manager /
 * stores / identity rather than a snapshot captured at construction time.
 */
export interface DeferredDecryptDeps {
  getManager: () => E2EEManager | null
  getStores: () => StoreBindings | null
  getOwnBareJid: () => string
  cache: DeferredDecryptCache
}

export class DeferredDecryptEngine {
  /**
   * Guard flag for {@link retryPending}. Prevents concurrent retry loops when
   * multiple triggers (plugin-registered, key-unlocked) fire close together.
   */
  private isRetrying = false

  /**
   * Set when a retry is requested while {@link retryPending} is already
   * running. The in-flight pass re-runs once on completion so a trigger that
   * arrives mid-pass (e.g. key-unlocked landing while the plugin-registered
   * pass is still in flight) is coalesced, never dropped.
   */
  private retryRequested = false

  constructor(private readonly deps: DeferredDecryptDeps) {}

  /**
   * Re-decrypt all stored messages that carry an {@link Message.encryptedPayload}
   * because decryption failed at receive time (no plugin registered, key
   * locked, etc.).
   *
   * Iterates both chat and room stores (via the injected bindings), reconstructs
   * the stanza from the serialized XML, and re-runs {@link decryptStanzaInPlace}.
   * On success the message body + securityContext are updated in-place via
   * `bindings.updateMessage()`, and the `encryptedPayload` is cleared.
   *
   * Protected by a flag to prevent concurrent retry loops when multiple
   * triggers fire close together.
   *
   * @returns the number of messages successfully decrypted
   */
  async retryPending(): Promise<number> {
    if (this.isRetrying) {
      // A pass is already running. Remember the request so the in-flight
      // pass re-runs on completion rather than dropping this trigger.
      this.retryRequested = true
      return 0
    }
    const manager = this.deps.getManager()
    if (!manager || !manager.hasPlugins()) return 0
    const stores = this.deps.getStores()
    if (!stores) return 0

    this.isRetrying = true
    let decryptedCount = 0
    // Chat messages handled by the in-memory pass below, so the durable-cache
    // pass can skip them (keyed by conversationId + message id).
    const handledChatKeys = new Set<string>()

    try {
      const chatBindings = stores.chat
      const roomBindings = stores.room

      // --- 1:1 chat messages ---
      // Read the full in-memory set (archived included) through the store
      // bindings, and mutate through them too, so the abstract API contract is
      // honoured for custom-store consumers.
      for (const { id: conversationId, messages } of chatBindings.getAllStoredMessages()) {
        for (const msg of messages) {
          if (!msg.encryptedPayload) continue
          handledChatKeys.add(`${conversationId} ${msg.id}`)
          const outcome = await this.decryptSingle(
            manager, msg.encryptedPayload, msg.from, conversationId,
          )
          if (outcome.kind === 'decrypted') {
            chatBindings.updateMessage(conversationId, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'modification') {
            this.applyChatModification(conversationId, msg, outcome.modification, chatBindings)
            decryptedCount++
          } else if (outcome.kind === 'rejected') {
            this.resolveRejectedPlaceholder(conversationId, msg, outcome.securityContext, chatBindings)
          } else if (outcome.kind === 'unsupported') {
            chatBindings.updateMessage(conversationId, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
      }

      // --- Room messages ---
      for (const { jid: roomJid, messages } of roomBindings.getAllRoomMessages()) {
        for (const msg of messages) {
          if (!msg.encryptedPayload) continue
          const outcome = await this.decryptSingle(
            manager, msg.encryptedPayload, msg.from, roomJid, 'room',
          )
          if (outcome.kind === 'decrypted') {
            roomBindings.updateMessage(roomJid, msg.id, {
              body: outcome.body,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              ...(outcome.attachment && { attachment: outcome.attachment }),
              encryptedPayload: undefined,
            })
            decryptedCount++
          } else if (outcome.kind === 'rejected') {
            // MUC carries no encrypted bodiless signals, so a rejected room
            // message always has real content — warn the user and clear the stash.
            roomBindings.updateMessage(roomJid, msg.id, {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            })
          } else if (outcome.kind === 'unsupported') {
            roomBindings.updateMessage(roomJid, msg.id, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            })
          }
        }
      }

      // --- Durable cache (web fresh-session reload) ---
      // Conversations the user has not opened are absent from the in-memory
      // store, so the loops above miss their stashed messages — they would
      // stay permanently "could not be decrypted" even after unlock. Repair
      // them straight in IndexedDB. The sparse `encryptedPayload` index makes
      // this O(pending), not a full-archive scan, and near-free when nothing
      // is pending (the steady state).
      for (const msg of await this.deps.cache.getMessagesWithEncryptedPayload()) {
        const conversationId = msg.conversationId
        if (!msg.encryptedPayload || !conversationId) continue
        if (handledChatKeys.has(`${conversationId} ${msg.id}`)) continue
        // Record so the preview-heal pass below skips a message this pass
        // already repaired (it heals the preview via refreshLastMessageContent).
        handledChatKeys.add(`${conversationId} ${msg.id}`)
        const outcome = await this.decryptSingle(
          manager, msg.encryptedPayload, msg.from, conversationId,
        )
        if (outcome.kind === 'decrypted') {
          const updates = {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          }
          await this.deps.cache.updateMessage(msg.id, updates)
          // The conversation's messages aren't loaded (durable path), so the
          // in-memory sidebar preview would keep the "[OpenPGP-encrypted
          // message]" fallback. Heal it when this message IS the preview.
          stores.chat.refreshLastMessageContent?.(conversationId, msg.id, updates)
          decryptedCount++
        } else if (outcome.kind === 'modification') {
          // Conversation isn't loaded in memory. Apply best-effort to the
          // in-memory target (no-op if absent) and drop the durable placeholder
          // so it can't resurrect as a "[could not decrypt]" bubble. The store
          // binding's removeMessage only touches in-memory state, so delete
          // from the durable cache explicitly. For never-opened conversations
          // the signal is reconciled on the next MAM catch-up, when the
          // now-unlocked key decrypts it inline.
          this.applyChatModification(conversationId, msg, outcome.modification, stores.chat)
          await this.deps.cache.deleteMessage(msg.id)
          decryptedCount++
        } else if (outcome.kind === 'rejected') {
          if (msg.body === COULD_NOT_DECRYPT_BODY) {
            // Bodiless-signal placeholder (forged reaction/retraction) — drop it.
            await this.deps.cache.deleteMessage(msg.id)
          } else {
            const updates = {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            }
            await this.deps.cache.updateMessage(msg.id, updates)
            stores.chat.refreshLastMessageContent?.(conversationId, msg.id, updates)
          }
        } else if (outcome.kind === 'unsupported') {
          const updates = {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          }
          await this.deps.cache.updateMessage(msg.id, updates)
          stores.chat.refreshLastMessageContent?.(conversationId, msg.id, updates)
        }
      }

      // --- Orphaned sidebar previews ---
      // A conversation's persisted preview (`conversationMeta.lastMessage`) can
      // carry an `encryptedPayload` + "[OpenPGP-encrypted message]" fallback that
      // NO message-store pass above reaches: the underlying message may have been
      // evicted from IndexedDB, already decrypted there (so the durable scan skips
      // it), or set preview-only by a MAM preview refresh that never stored a
      // message row. The preview itself is then the sole carrier of the
      // ciphertext, and would stay stuck on the fallback until the conversation is
      // opened. Re-decrypt straight from the stash and heal the preview in place.
      // Runs after the store passes so a preview already healed by them (its
      // `encryptedPayload` cleared) is naturally excluded from the enumeration.
      for (const { conversationId, lastMessage } of chatBindings.getEncryptedPreviews?.() ?? []) {
        if (!lastMessage.encryptedPayload) continue
        // Skip a preview whose message a store pass already repaired — that pass
        // heals the preview in place (updateMessage / refreshLastMessageContent),
        // so re-decrypting here would be redundant work.
        if (handledChatKeys.has(`${conversationId} ${lastMessage.id}`)) continue
        const outcome = await this.decryptSingle(
          manager, lastMessage.encryptedPayload, lastMessage.from, conversationId,
        )
        if (outcome.kind === 'decrypted') {
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage.id, {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          })
          decryptedCount++
        } else if (outcome.kind === 'unsupported') {
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage.id, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          })
        } else if (outcome.kind === 'rejected') {
          // A preview is always a real previewable message (bodiless-signal
          // placeholders are never previewable), so warn with the rejected body.
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage.id, {
            body: MESSAGE_REJECTED_BODY,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            encryptedPayload: undefined,
          })
        }
        // 'modification' (reaction/retraction) can't be a preview, and 'pending'
        // means the key is still locked — leave the stash for a later pass.
      }

      if (decryptedCount > 0) {
        logInfo(`E2EE deferred decrypt: successfully decrypted ${decryptedCount} message(s)`)
      }
    } finally {
      this.isRetrying = false
    }

    // A trigger that arrived mid-pass was coalesced — run once more so its
    // newly-available state (e.g. a just-unlocked key) is applied.
    if (this.retryRequested) {
      this.retryRequested = false
      decryptedCount += await this.retryPending()
    }

    return decryptedCount
  }

  /**
   * Apply a bodiless signal (XEP-0444 reaction or XEP-0424 retraction)
   * recovered from a deferred decrypt to its target message, then remove the
   * "[could not decrypt]" placeholder it was provisionally stored under. The
   * sender of the placeholder stanza is the actor — our own bare JID for a
   * self-outgoing MAM replay, the peer's for an inbound one. A retraction is
   * only honoured when that actor authored the target (mirrors the live path).
   */
  private applyChatModification(
    conversationId: string,
    placeholder: { id: string; from: string },
    modification: RetryModification,
    chatBindings: StoreBindings['chat'],
  ): void {
    const actorJid = getBareJid(placeholder.from)
    // Diagnostic (race investigation): a deferred reaction/retraction can only
    // attach to its target if that target is in the loaded set when this runs.
    // retryPending is a one-shot pass (launch / key-unlock); nothing re-runs it
    // when a target enters the store later via scroll/MAM. Record whether
    // target + placeholder were present so a "resolved only after relaunch"
    // report can be confirmed against the actual presence at apply time.
    // Domains only — no message content.
    const targetPresent = !!chatBindings.getMessage(conversationId, modification.targetId)
    const placeholderPresent = !!chatBindings.getMessage(conversationId, placeholder.id)
    logInfo(
      `E2EE deferred modification: type=${modification.type} conv=${getDomain(conversationId)} ` +
      `targetPresent=${targetPresent} placeholderPresent=${placeholderPresent}` +
      (targetPresent ? '' : ' — target not loaded, signal cannot attach until a later pass'),
    )
    if (modification.type === 'reactions') {
      chatBindings.updateReactions(conversationId, modification.targetId, actorJid, modification.emojis)
    } else {
      const target = chatBindings.getMessage(conversationId, modification.targetId)
      const updates = applyRetraction(!!target && target.from === actorJid)
      if (updates) chatBindings.updateMessage(conversationId, modification.targetId, updates)
    }
    chatBindings.removeMessage(conversationId, placeholder.id)
  }

  /**
   * Resolve a chat placeholder whose deferred decrypt was finally rejected
   * (invalid signature — final, never retried again). A bodiless-signal
   * placeholder still carries the {@link COULD_NOT_DECRYPT_BODY} marker that
   * stanzaDecrypt stamps onto reactions/retractions; it is removed entirely so
   * a forged signal never surfaces as a ghost bubble. A real message
   * placeholder (any other body) is replaced with a "[Message rejected]" body
   * so the user is warned the message could not be trusted.
   */
  private resolveRejectedPlaceholder(
    conversationId: string,
    placeholder: { id: string; body: string },
    securityContext: MessageSecurityContext | undefined,
    chatBindings: StoreBindings['chat'],
  ): void {
    if (placeholder.body === COULD_NOT_DECRYPT_BODY) {
      chatBindings.removeMessage(conversationId, placeholder.id)
    } else {
      chatBindings.updateMessage(conversationId, placeholder.id, {
        body: MESSAGE_REJECTED_BODY,
        ...(securityContext && { securityContext }),
        encryptedPayload: undefined,
      })
    }
  }

  /**
   * Attempt to decrypt a single stashed payload — either a full original
   * `<message>` stanza (current format, keeps outer reply/fallback context)
   * or a bare encrypted element (legacy persisted stashes).
   * @returns `RetryOutcome` describing whether decryption succeeded, the
   *   protocol is unsupported, or the message should remain pending.
   */
  private async decryptSingle(
    manager: E2EEManager,
    encryptedPayloadXml: string,
    senderJid: string,
    peer: string,
    messageContext: 'chat' | 'room' = 'chat',
  ): Promise<RetryOutcome> {
    try {
      const parsedPayload = ltx.parse(encryptedPayloadXml) as unknown as Element

      // Current stashes hold the full original <message> stanza so outer
      // cleartext context (XEP-0461 <reply>, XEP-0428 <fallback> ranges)
      // survives until this retry. Stashes persisted before that format
      // hold just the encrypted child and need a minimal wrapper.
      const stanza =
        parsedPayload.name === 'message'
          ? parsedPayload
          : (xml('message', { from: senderJid }, parsedPayload) as Element)
      if (!stanza.attrs.from) stanza.attrs.from = senderJid

      // Detect self-outgoing (sent carbon or MAM self-replay): when the
      // sender's bare JID equals our own, the signcrypt envelope's <to/>
      // addresses the conversation peer — not us — so the plugin's
      // reflection check must be inverted via isSelfOutgoing.
      const ownBareJid = this.deps.getOwnBareJid()
      const isSelfOutgoing = ownBareJid !== '' && getBareJid(senderJid) === ownBareJid

      const result = await decryptStanzaInPlace(
        stanza, manager, peer, 'archive',
        isSelfOutgoing ? { isSelfOutgoing: true } : undefined,
      )

      // Protocol we have no plugin for (e.g. OMEMO): nothing to retry. Drop the
      // encryptedPayload and tag the message so the already-stored fallback body
      // renders with an "unsupported method" hint.
      if (result.unsupportedEncryption) {
        return { kind: 'unsupported', info: result.unsupportedEncryption }
      }

      if (!result.attempted || result.encryptedPayloadXml) {
        // Still can't decrypt
        return { kind: 'pending' }
      }

      // A rejected signature is final — never retryable. decryptStanzaInPlace
      // threw before unwrapping the payload, so no <reactions>/<retract>/<body>
      // was surfaced; the caller decides whether to show a "[Message rejected]"
      // bubble (real message placeholder) or drop it (bodiless-signal placeholder).
      if (result.securityContext?.trust === 'rejected') {
        return {
          kind: 'rejected',
          securityContext: {
            protocolId: result.securityContext.protocolId,
            trust: result.securityContext.trust,
            ...(result.securityContext.notes && { notes: result.securityContext.notes }),
          },
        }
      }

      // Bodiless signal stanzas (XEP-0444 reactions, XEP-0424 retractions)
      // carry no <body> — the whole element rode inside the encrypted payload
      // and now sits at the stanza root after decryptStanzaInPlace unwrapped
      // it. These were stored under a "[could not decrypt]" placeholder while
      // the key was locked; returning 'pending' here (the historical body-only
      // behaviour) silently dropped them. Surface them as a modification so the
      // caller applies the signal to its target and removes the placeholder.
      const reactions = parseReactionsSignal(stanza)
      if (reactions?.targetId) {
        return {
          kind: 'modification',
          modification: { type: 'reactions', targetId: reactions.targetId, emojis: reactions.emojis },
        }
      }
      const retraction = parseRetractionSignal(stanza)
      if (retraction?.targetId) {
        return { kind: 'modification', modification: { type: 'retract', targetId: retraction.targetId } }
      }

      // Extract the decrypted body
      const body = stanza.getChildText('body')
      if (!body) return { kind: 'pending' }

      // Re-run the shared content parse on the decrypted stanza: strips
      // XEP-0428 fallback ranges (e.g. the XEP-0461 reply quote that the
      // sender prefixed to the encrypted body) and extracts the attachment
      // (aesgcm:// URI, XEP-0446 file metadata, XEP-0264 thumbnails).
      // Legacy bare-element stashes carry no outer <fallback>, so their
      // body passes through unchanged.
      const parsed = parseMessageContent({ messageEl: stanza, body, messageContext })
      const processedBody = parsed.processedBody
      const attachment = parsed.attachment
      if (attachment) {
        logDebug(
          `E2EE deferred decrypt: attachment from ${getDomain(senderJid)} — ` +
          `url=${attachment.url.slice(0, 40)}… mediaType=${attachment.mediaType ?? 'none'} ` +
          `encrypted=${!!attachment.encryption} name=${attachment.name ? '<redacted>' : 'none'}`,
        )
      }

      // Map SecurityContext to MessageSecurityContext
      let securityContext: MessageSecurityContext | undefined
      if (result.securityContext) {
        securityContext = {
          protocolId: result.securityContext.protocolId,
          trust: result.securityContext.trust,
          ...(result.securityContext.notes && { notes: result.securityContext.notes }),
          ...(result.securityContext.fingerprint && { fingerprint: result.securityContext.fingerprint }),
        }
      }

      return {
        kind: 'decrypted',
        body: processedBody,
        ...(securityContext && { securityContext }),
        ...(attachment && { attachment }),
      }
    } catch (err) {
      logWarn(`E2EE deferred decrypt failed for message from ${getDomain(senderJid)}: ${err instanceof Error ? err.message : String(err)}`)
      return { kind: 'pending' }
    }
  }

  /**
   * Re-attempt deferred decrypts AND upgrade stale trust for a specific
   * peer, triggered when that peer's PEP key material changes.
   *
   * Two categories of stored messages are handled:
   *
   * 1. Messages with `encryptedPayload` — the peer key was not available
   *    when the message was first processed, so the signature could not be
   *    verified. Re-decrypt now that the key may be cached.
   *
   * 2. Old messages without `encryptedPayload` but with
   *    `securityContext.trust === 'untrusted'` and a "not cached" note —
   *    these were persisted before the payload-stash fix landed. We cannot
   *    re-verify their signatures (the ciphertext is gone), but the
   *    decryption + signcrypt envelope validation succeeded, so upgrading
   *    to `tofu` is a sound pragmatic trade-off.
   */
  async retryForPeer(peer: string): Promise<void> {
    const manager = this.deps.getManager()
    if (!manager || !manager.hasPlugins()) return
    const stores = this.deps.getStores()
    if (!stores) return

    const chatBindings = stores.chat
    const peerMessages = chatBindings.getConversationMessages(peer)
    if (peerMessages.length === 0) return

    let updated = 0
    for (const msg of peerMessages) {
      if (msg.encryptedPayload) {
        const outcome = await this.decryptSingle(
          manager, msg.encryptedPayload, msg.from, peer,
        )
        if (outcome.kind === 'decrypted') {
          chatBindings.updateMessage(peer, msg.id, {
            body: outcome.body,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            ...(outcome.attachment && { attachment: outcome.attachment }),
            encryptedPayload: undefined,
          })
          updated++
        } else if (outcome.kind === 'unsupported') {
          chatBindings.updateMessage(peer, msg.id, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          })
          updated++
        }
        continue
      }
      if (
        msg.securityContext?.trust === 'untrusted' &&
        msg.securityContext.notes?.some((n) => n.includes('not cached'))
      ) {
        chatBindings.updateMessage(peer, msg.id, {
          securityContext: {
            protocolId: msg.securityContext.protocolId,
            trust: 'tofu',
          },
        })
        updated++
      }
    }
    if (updated > 0) {
      logInfo(`E2EE peer key change: updated ${updated} message(s) for ${getDomain(peer)}`)
    }
  }
}
