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
import { parseMessageContent, parseReactionsSignal, parseRetractionSignal, parseCorrectionSignal, applyCorrection, parseOgpFastening, isMessageSignal } from '../modules/messagingUtils'
import { getBareJid, getDomain } from '../jid'
import { logDebug, logInfo, logWarn } from '../logger'
import type { StoreBindings, MessageSecurityContext, FileAttachment, Message } from '../types'
import { captureContentSource, resolveCorrectionUpdates, compareCorrectionRevisions, sameCorrection, type MessageImplState, type CorrectionUpdates, type StoredMessage, type StoredRoomMessage } from '../types/message-internal'
import { captureStorageScope } from '../../utils/storageScope'
import type { ArchiveSignal } from '../../utils/archiveSignal'
import { chatMessageAuthor, resolveMessageReference } from '../../utils/messageIdentity'
import { NS_FASTEN, NS_DELAY } from '../namespaces'
import { chatCacheKey, type CachedChatMessage } from '../../utils/messageCache'

/** A recovered signal updates another message instead of retaining its placeholder. */
type RetryModification = ArchiveSignal['effect']

/**
 * Result of a single deferred-decrypt attempt.
 * - `decrypted`: plaintext recovered — update body/security/attachment, clear `encryptedPayload`.
 *   When `unverified`, the signature waits for the sender's key: the text is stored
 *   untrusted and `encryptedPayload` stays for the later signature check.
 * - `modification`: decrypt surfaced a signal targeting another message —
 *   durably record it, apply its target effect and remove the placeholder.
 * - `unsupported`: protocol we have no plugin for — clear `encryptedPayload`, tag `unsupportedEncryption`, keep body.
 * - `rejected`: signature is invalid (final, never retryable) — a real message placeholder is
 *   replaced with a "[Message rejected]" body; a bodiless-signal placeholder (forged reaction/
 *   retraction) is removed entirely so it never surfaces as a ghost bubble.
 * - `pending`: still cannot decrypt (key locked / plugin not ready) — leave `encryptedPayload`.
 */
type RetryOutcome =
  | { kind: 'decrypted'; authoredAt?: Date; body: string; securityContext?: MessageSecurityContext; attachment?: FileAttachment; unverified?: true }
  | { kind: 'modification'; modification: RetryModification; stanza: string; securityContext?: MessageSecurityContext; authoredAt?: Date }
  | { kind: 'unsupported'; info: { namespace: string; name: string } }
  | { kind: 'rejected'; securityContext?: MessageSecurityContext }
  | { kind: 'pending' }

/**
 * Message-cache port — the durable IndexedDB slice the engine repairs for
 * conversations that are not loaded in memory. Injected so the engine has no
 * direct module-global dependency and is unit-testable in isolation.
 */
export interface DeferredDecryptCache {
  getMessagesWithEncryptedPayload: () => Promise<CachedChatMessage[]>
  updateMessage: (
    conversationId: string,
    id: string,
    updates: Partial<Message>,
    from: string,
    scopeJid?: string | null,
    expectedCacheKey?: string
  ) => Promise<void>
  deleteMessageForRecovery?: (conversationId: string, message: Message, scopeJid: string | null) => Promise<boolean>
  deleteMessage: (
    conversationId: string,
    id: string,
    from: string,
    scopeJid?: string | null,
    expectedCacheKey?: string
  ) => Promise<void>
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
  updateSearchIndex: (message: Message, scopeJid: string | null) => Promise<void>
  /** Bound on one plugin decrypt, in milliseconds. Defaults to {@link DEFAULT_DECRYPT_TIMEOUT_MS}. */
  decryptTimeoutMs?: number
}

/**
 * A plugin decrypt can stay unsettled forever: iOS suspends the WKWebView web
 * process shortly after the app is backgrounded, and a native IPC call in
 * flight at that moment may never return. Without a bound, one such call holds
 * the engine's single-pass guard for the rest of the session. The value sits
 * well above a real decrypt, including a sender-key PEP fetch, so it only fires
 * for a call that is lost.
 */
const DEFAULT_DECRYPT_TIMEOUT_MS = 60_000

const TIMED_OUT = Symbol('timed-out')

/** Settles with the promise's outcome, or with {@link TIMED_OUT} once `ms` elapse first. */
function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<typeof TIMED_OUT>((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), ms) })
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer))
}

function guardedUpdates<T>(message: CorrectionUpdates & { from: string }, updates: T, accountScope: string | null) {
  return {
    ...updates,
    contentRecovery: {
      encryptedPayload: message.encryptedPayload,
      revisionIds: message.correctionRevision?.ids ?? [],
      isEdited: !!message.isEdited,
      from: message.from,
      occupantId: message.occupantId,
      accountScope,
    },
  }
}

function recoveredUpdates(
  message: MessageImplState & { isEdited?: boolean; from: string; encryptedPayload?: string; occupantId?: string },
  outcome: Extract<RetryOutcome, { kind: 'decrypted' }>,
  accountScope: string | null,
) {
  return guardedUpdates(message, {
    body: outcome.body,
    ...(outcome.securityContext && { securityContext: outcome.securityContext }),
    ...(outcome.attachment && { attachment: outcome.attachment }),
    ...(message.isEdited && {
      isEdited: true,
      correctionRevision: message.correctionRevision,
      ...(outcome.authoredAt && { correctionTimestamp: outcome.authoredAt.getTime(), correctionTimestampSource: 'authored' as const }),
    }),
    ...(!outcome.unverified && { encryptedPayload: undefined }),
  }, accountScope)
}

/**
 * An unverified decrypt repeats on every pass until the sender's key arrives.
 * Once the message shows its text, a later pass leaves it alone: rewriting it
 * would only repeat the write, or undo a trust upgrade the plugin reported
 * in between.
 */
function unlessShown(
  message: { body?: string; securityContext?: MessageSecurityContext },
  outcome: RetryOutcome,
): RetryOutcome {
  if (outcome.kind !== 'decrypted' || !outcome.unverified) return outcome
  const shown = message.securityContext
  if (!shown || message.body !== outcome.body) return outcome
  const sameNotes = JSON.stringify(shown.notes ?? []) === JSON.stringify(outcome.securityContext?.notes ?? [])
  return shown.trust !== 'untrusted' || sameNotes ? { kind: 'pending' } : outcome
}

export interface CorrectionRecovery {
  message: StoredMessage | StoredRoomMessage
  isCurrent: () => boolean
  apply: (updates: CorrectionUpdates) => void
}

export class DeferredDecryptEngine {
  private correctionRecoveries = new Map<string, CorrectionRecovery>()

  recoverCorrection(message: StoredMessage | StoredRoomMessage, isCurrent: () => boolean, apply: CorrectionRecovery['apply']): void {
    const key = JSON.stringify([message.type, 'roomJid' in message ? message.roomJid : message.conversationId,
      message.stanzaId ?? message.id, message.from, 'occupantId' in message ? message.occupantId : undefined])
    if (!isCurrent()) return
    const pending = this.correctionRecoveries.get(key)
    if (pending?.isCurrent() && !message.isRetracted && !sameCorrection(pending.message, message) &&
        compareCorrectionRevisions(message, pending.message) <= 0) return
    if (!message.encryptedPayload || message.isRetracted) { this.correctionRecoveries.delete(key); return }
    this.correctionRecoveries.set(key, { message, isCurrent, apply })
    void this.retryPending().catch(error => logWarn(`Failed to recover correction: ${String(error)}`))
  }

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
    return this.retryPendingMessages()
  }

  private async retryPendingMessages(peer?: string): Promise<number> {
    if (this.isRetrying) {
      // A pass is already running. Remember the request so the in-flight
      // pass re-runs on completion rather than dropping this trigger.
      this.retryRequested = true
      return 0
    }
    const manager = this.deps.getManager()
    // With declared plugins a pass is useful before any registers: it tags
    // stored payloads of protocols no declared plugin handles as unsupported,
    // while payloads a declared plugin may still decrypt stay pending.
    if (!manager || !(manager.hasPlugins() || manager.hasDeclaredPlugins())) return 0
    const stores = this.deps.getStores()
    if (!stores) return 0

    const storageScope = captureStorageScope()
    const accountScope = storageScope.jid
    const ownJid = this.deps.getOwnBareJid()
    const accountChanged = () => !storageScope.isCurrent() || this.deps.getOwnBareJid() !== ownJid || this.deps.getManager() !== manager || this.deps.getStores() !== stores
    this.isRetrying = true
    let decryptedCount = 0
    // Chat messages handled by the in-memory pass below, so the durable-cache
    // pass can skip them (keyed by conversationId + message id).
    const handledChatKeys = new Set<string>()

    try {
      const chatBindings = stores.chat
      const roomBindings = stores.room
      const handledRoomKeys = new Set<string>()
      for (const [key, request] of this.correctionRecoveries) {
        if (!request.isCurrent()) { this.correctionRecoveries.delete(key); continue }
        const { message } = request
        const room = 'roomJid' in message
        const conversationId = room ? message.roomJid : message.conversationId
        if (peer && (room || conversationId !== peer)) continue
        if (room) handledRoomKeys.add(JSON.stringify([message.roomJid, message.stanzaId ?? message.id, message.from, message.occupantId]))
        else handledChatKeys.add(chatCacheKey(message))
        const outcome = unlessShown(message, await this.decryptSingle(manager, message.encryptedPayload!, message.from, conversationId, room ? 'room' : 'chat', room ? undefined : message as StoredMessage))
        if (accountChanged()) return decryptedCount
        if (this.correctionRecoveries.get(key) !== request) continue
        if (!request.isCurrent()) { this.correctionRecoveries.delete(key); continue }
        if (outcome.kind === 'pending') continue
        this.correctionRecoveries.delete(key)
        if (outcome.kind === 'decrypted') {
          request.apply(recoveredUpdates(message, outcome, accountScope))
          decryptedCount++
        } else if (outcome.kind === 'unsupported') {
          request.apply(guardedUpdates(message, { encryptedPayload: undefined, unsupportedEncryption: outcome.info }, accountScope))
        } else {
          request.apply(guardedUpdates(message, { encryptedPayload: undefined, body: MESSAGE_REJECTED_BODY,
            ...(outcome.kind === 'rejected' && { securityContext: outcome.securityContext }) }, accountScope))
        }
      }


      // --- 1:1 chat messages ---
      // Read the full in-memory set (archived included) through the store
      // bindings, and mutate through them too, so the abstract API contract is
      // honoured for custom-store consumers.
      const conversations = peer
        ? [{ id: peer, messages: chatBindings.getConversationMessages(peer) }]
        : chatBindings.getAllStoredMessages()
      for (const { id: conversationId, messages } of conversations) {
        for (const msg of messages) {
          if (!msg.encryptedPayload || handledChatKeys.has(chatCacheKey(msg))) continue
          handledChatKeys.add(chatCacheKey(msg))
          const outcome = unlessShown(msg, await this.decryptSingle(
            manager, msg.encryptedPayload, msg.from, conversationId, 'chat', msg,
          ))
          if (accountChanged()) return decryptedCount
          if (outcome.kind === 'decrypted') {
            chatBindings.updateMessage(conversationId, msg, recoveredUpdates(msg, outcome, accountScope))
            decryptedCount++
          } else if (outcome.kind === 'modification') {
            if (!await this.dropChatPlaceholder(conversationId, msg, stores, accountScope, accountChanged, outcome)) continue
            if (accountChanged()) return decryptedCount
            decryptedCount++
          } else if (outcome.kind === 'rejected') {
            if (msg.body === COULD_NOT_DECRYPT_BODY) {
              await this.dropChatPlaceholder(conversationId, msg, stores, accountScope, accountChanged)
              if (accountChanged()) return decryptedCount
            } else {
              this.rejectChatMessage(conversationId, msg, outcome.securityContext, chatBindings, accountScope)
            }
          } else if (outcome.kind === 'unsupported') {
            chatBindings.updateMessage(conversationId, msg, guardedUpdates(msg, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            }, accountScope))
          }
        }
      }

      // --- Room messages ---
      // Rooms whose encrypted-payload badge may need reconciling once their
      // stashed messages settle this pass — see the recount loop below.
      const roomsToRecount = new Set<string>()
      for (const { jid: roomJid, messages } of peer ? [] : roomBindings.getAllRoomMessages()) {
        for (const msg of messages) {
          if (!msg.encryptedPayload || handledRoomKeys.has(JSON.stringify([roomJid, msg.stanzaId ?? msg.id, msg.from, msg.occupantId]))) continue
          const outcome = unlessShown(msg, await this.decryptSingle(
            manager, msg.encryptedPayload, msg.from, roomJid, 'room',
          ))
          if (accountChanged()) return decryptedCount
          if (outcome.kind === 'decrypted') {
            roomBindings.updateMessage(roomJid, msg.id, recoveredUpdates(msg, outcome, accountScope))
            decryptedCount++
            roomsToRecount.add(roomJid)
          } else if (outcome.kind === 'rejected') {
            // MUC carries no encrypted bodiless signals, so a rejected room
            // message always has real content — warn the user and clear the stash.
            roomBindings.updateMessage(roomJid, msg.id, guardedUpdates(msg, {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            }, accountScope))
            roomsToRecount.add(roomJid)
          } else if (outcome.kind === 'unsupported') {
            roomBindings.updateMessage(roomJid, msg.id, guardedUpdates(msg, {
              encryptedPayload: undefined,
              unsupportedEncryption: outcome.info,
            }, accountScope))
            roomsToRecount.add(roomJid)
          }
        }
      }

      // A stashed room message resolving here (decrypted / rejected /
      // unsupported) is exactly the class of event that can leave a room's
      // badge stale — the live path counted it while its true renderability
      // was unknown. Room recount has no equivalent of the durable-cache pass
      // below (there is no room analogue of `getMessagesWithEncryptedPayload`),
      // so this is the ONLY place a room's deferred-decrypt badge reconciles.
      // recomputeUnreadForRoom's own defer/coverage gates make this safe to
      // call unconditionally — an entity not yet caught up simply defers.
      for (const roomJid of roomsToRecount) {
        await roomBindings.recomputeUnreadForRoom?.(roomJid)
        if (accountChanged()) return decryptedCount
      }

      // --- Durable cache (web fresh-session reload) ---
      // Conversations the user has not opened are absent from the in-memory
      // store, so the loops above miss their stashed messages — they would
      // stay permanently "could not be decrypted" even after unlock. Repair
      // them straight in IndexedDB. The sparse `encryptedPayload` index makes
      // this O(pending), not a full-archive scan, and near-free when nothing
      // is pending (the steady state).
      const pendingMessages = await this.deps.cache.getMessagesWithEncryptedPayload()
      if (accountChanged()) return decryptedCount
      for (const msg of pendingMessages) {
        if (accountChanged()) return decryptedCount
        const conversationId = msg.conversationId
        if (!msg.encryptedPayload || !conversationId || (peer && conversationId !== peer)) continue
        if (handledChatKeys.has(msg.cacheKey)) continue
        // Record so the preview-heal pass below skips a message this pass
        // already repaired (it heals the preview via refreshLastMessageContent).
        handledChatKeys.add(msg.cacheKey)
        const outcome = unlessShown(msg, await this.decryptSingle(
          manager, msg.encryptedPayload, msg.from, conversationId, 'chat', msg,
        ))
        if (accountChanged()) return decryptedCount
        if (outcome.kind === 'decrypted') {
          const updates = recoveredUpdates(msg, outcome, accountScope)
          await this.deps.cache.updateMessage(conversationId, msg.id, updates, msg.from, accountScope, msg.cacheKey)
          if (accountChanged()) return decryptedCount
          await this.deps.updateSearchIndex({ ...msg, ...updates }, accountScope)
            .catch(error => logWarn(`Failed to index recovered message: ${String(error)}`))
          if (accountChanged()) return decryptedCount
          // The conversation's messages aren't loaded (durable path), so the
          // in-memory sidebar preview would keep the "[OpenPGP-encrypted
          // message]" fallback. Heal it when this message IS the preview.
          stores.chat.refreshLastMessageContent?.(conversationId, msg, updates)
          decryptedCount++
        } else if (outcome.kind === 'modification') {
          if (!await this.dropChatPlaceholder(conversationId, msg, stores, accountScope, accountChanged, outcome)) continue
          if (accountChanged()) return decryptedCount
          decryptedCount++
        } else if (outcome.kind === 'rejected') {
          if (msg.body === COULD_NOT_DECRYPT_BODY) {
            await this.dropChatPlaceholder(conversationId, msg, stores, accountScope, accountChanged)
            if (accountChanged()) return decryptedCount
          } else {
            const updates = guardedUpdates(msg, {
              body: MESSAGE_REJECTED_BODY,
              ...(outcome.securityContext && { securityContext: outcome.securityContext }),
              encryptedPayload: undefined,
            }, accountScope)
            await this.deps.cache.updateMessage(conversationId, msg.id, updates, msg.from, accountScope, msg.cacheKey)
            if (accountChanged()) return decryptedCount
            await this.deps.updateSearchIndex({ ...msg, ...updates }, accountScope)
              .catch(error => logWarn(`Failed to index recovered message: ${String(error)}`))
            if (accountChanged()) return decryptedCount
            stores.chat.refreshLastMessageContent?.(conversationId, msg, updates)
          }
        } else if (outcome.kind === 'unsupported') {
          const updates = guardedUpdates(msg, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          }, accountScope)
          await this.deps.cache.updateMessage(conversationId, msg.id, updates, msg.from, accountScope, msg.cacheKey)
          if (accountChanged()) return decryptedCount
          stores.chat.refreshLastMessageContent?.(conversationId, msg, updates)
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
        if (!lastMessage.encryptedPayload || (peer && conversationId !== peer)) continue
        // Skip a preview whose message a store pass already repaired — that pass
        // heals the preview in place (updateMessage / refreshLastMessageContent),
        // so re-decrypting here would be redundant work.
        if (handledChatKeys.has(chatCacheKey(lastMessage))) continue
        const outcome = unlessShown(lastMessage, await this.decryptSingle(
          manager, lastMessage.encryptedPayload, lastMessage.from, conversationId, 'chat', lastMessage,
        ))
        if (accountChanged()) return decryptedCount
        if (outcome.kind === 'decrypted') {
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage, recoveredUpdates(lastMessage, outcome, accountScope))
          decryptedCount++
        } else if (outcome.kind === 'modification') {
          // Until decrypted, an outgoing signal can carry a fallback body and
          // become the preview even though it has no row in loaded history.
          if (!await this.dropChatPlaceholder(conversationId, lastMessage, stores, accountScope, accountChanged, outcome)) continue
          if (accountChanged()) return decryptedCount
          decryptedCount++
        } else if (outcome.kind === 'unsupported') {
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage, guardedUpdates(lastMessage, {
            encryptedPayload: undefined,
            unsupportedEncryption: outcome.info,
          }, accountScope))
        } else if (outcome.kind === 'rejected') {
          // A preview is always a real previewable message (bodiless-signal
          // placeholders are never previewable), so warn with the rejected body.
          chatBindings.refreshLastMessageContent?.(conversationId, lastMessage, guardedUpdates(lastMessage, {
            body: MESSAGE_REJECTED_BODY,
            ...(outcome.securityContext && { securityContext: outcome.securityContext }),
            encryptedPayload: undefined,
          }, accountScope))
        }
        // 'pending' means the key is still locked — leave the stash for a later pass.
      }

      if (decryptedCount > 0) {
        logInfo(`E2EE deferred decrypt: successfully decrypted ${decryptedCount} message(s)`)
      }
    } finally {
      this.isRetrying = false
      if (this.retryRequested) {
        this.retryRequested = false
        decryptedCount += await this.retryPending()
      }
    }

    return decryptedCount
  }

  private async dropChatPlaceholder(
    conversationId: string,
    placeholder: Message,
    stores: StoreBindings,
    accountScope: string | null,
    accountChanged: () => boolean,
    outcome?: Extract<RetryOutcome, { kind: 'modification' }>,
  ): Promise<boolean> {
    const contentRecovery = captureContentSource(placeholder, accountScope)
    const isCurrent = () => {
      const current = stores.chat.getMessage(conversationId, placeholder)
      return !current || !!resolveCorrectionUpdates(current, { contentRecovery }, accountScope)
    }
    if (!isCurrent()) return false
    const archiveId = placeholder.ownArchiveBy === accountScope ? placeholder.ownArchiveId : undefined
    // The journal owns the revision check, target write and placeholder deletion
    // in one transaction. Deleting first would prevent rollback on a failed write.
    if (outcome && archiveId && stores.chat.rememberArchiveSignalForRecovery) {
      if (!await stores.chat.rememberArchiveSignalForRecovery({
        conversationId, archiveId, from: getBareJid(placeholder.from), id: placeholder.id,
        stanza: outcome.stanza, timestamp: placeholder.timestamp.getTime(), effect: outcome.modification,
        securityContext: outcome.securityContext, authoredAt: outcome.authoredAt?.getTime(),
      }, placeholder, accountScope)) return false
    } else if (this.deps.cache.deleteMessageForRecovery) {
      if (!await this.deps.cache.deleteMessageForRecovery(conversationId, placeholder, accountScope)) return false
    } else {
      await this.deps.cache.deleteMessage(conversationId, placeholder.id, placeholder.from, accountScope, chatCacheKey(placeholder))
    }
    if (accountChanged() || !isCurrent()) return false
    const selected = { ...placeholder, contentRecovery }
    if (outcome && !(archiveId && stores.chat.rememberArchiveSignalForRecovery && outcome.modification.type === 'reactions')) {
      this.applyChatModification(conversationId, selected, outcome.modification, stores.chat)
    } else stores.chat.removeMessage(conversationId, selected)
    await stores.chat.recomputeUnreadForConversation?.(conversationId, { allowActive: true })
    return true
  }

  /** Apply a recovered signal through the same bindings as live traffic. */
  private applyChatModification(
    conversationId: string,
    placeholder: Message,
    modification: RetryModification,
    chatBindings: StoreBindings['chat'],
  ): void {
    const actorJid = getBareJid(placeholder.from)
    const targetPresent = !!chatBindings.getMessage(conversationId, modification.targetId)
    const placeholderPresent = !!chatBindings.getMessage(conversationId, placeholder)
    logInfo(
      `E2EE deferred modification: type=${modification.type} conv=${getDomain(conversationId)} ` +
      `targetPresent=${targetPresent} placeholderPresent=${placeholderPresent}`,
    )
    if (modification.type === 'reactions') {
      chatBindings.updateReactions(conversationId, modification.targetId, actorJid, modification.emojis)
    } else if (modification.type === 'retract') {
      chatBindings.recordPendingRetraction(conversationId, modification.targetId, actorJid)
    } else {
      const resolution = resolveMessageReference(chatBindings.getConversationMessages(conversationId), modification.targetId,
        modification.authorOnly ? 'archive-first' : 'client-id-first')
      const target = resolution?.candidates.find(({ message }) => !modification.authorOnly || chatMessageAuthor(message, { actorJid }))?.message
      if (target) chatBindings.updateMessage(conversationId, target, {
        ...modification.updates,
        ...(modification.authorOnly && { originalBody: target.originalBody ?? target.body }),
      })
    }
    chatBindings.removeMessage(conversationId, placeholder)
  }

  /** Replace rejected message content without changing its read position or identity. */
  private rejectChatMessage(
    conversationId: string,
    placeholder: Message & MessageImplState,
    securityContext: MessageSecurityContext | undefined,
    chatBindings: StoreBindings['chat'],
    accountScope: string | null,
  ): void {
    chatBindings.updateMessage(conversationId, placeholder, guardedUpdates(placeholder, {
      body: MESSAGE_REJECTED_BODY,
      ...(securityContext && { securityContext }),
      encryptedPayload: undefined,
    }, accountScope))
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
    archiveMessage?: StoredMessage,
  ): Promise<RetryOutcome> {
    const scope = captureStorageScope()
    const stores = this.deps.getStores()
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

      // A late result is dropped with the abandoned call: `stanza` is a local
      // parse, and nothing below runs for it. The stash stays for a later pass.
      const result = await settleWithin(decryptStanzaInPlace(
        stanza, manager, peer, 'archive',
        isSelfOutgoing ? { isSelfOutgoing: true } : undefined,
      ), this.deps.decryptTimeoutMs ?? DEFAULT_DECRYPT_TIMEOUT_MS)
      if (result === TIMED_OUT) {
        logWarn(`E2EE deferred decrypt timed out for message from ${getDomain(senderJid)}; leaving it pending`)
        return { kind: 'pending' }
      }

      // Protocol we have no plugin for (e.g. OMEMO): nothing to retry. Drop the
      // encryptedPayload and tag the message so the already-stored fallback body
      // renders with an "unsupported method" hint.
      if (result.unsupportedEncryption) {
        return { kind: 'unsupported', info: result.unsupportedEncryption }
      }

      // Decrypted, but the signature waits for the sender's key. Its text is
      // stored below, untrusted, as the live path stores it.
      const unverified = !!result.awaitsVerification
      if (!result.attempted || (result.encryptedPayloadXml && !unverified)) {
        // Still can't decrypt
        return { kind: 'pending' }
      }
      // A reaction, retraction, link preview or correction changes another
      // message and removes its placeholder, which would also drop the
      // encrypted copy before the signature check. It waits for that check.
      if (unverified && (isMessageSignal(stanza) || stanza.getChild('apply-to', NS_FASTEN))) {
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
          kind: 'modification', stanza: stanza.toString(), securityContext: result.securityContext, authoredAt: result.authoredAt,
          modification: { type: 'reactions', targetId: reactions.targetId, emojis: reactions.emojis },
        }
      }
      const retraction = parseRetractionSignal(stanza)
      if (retraction?.targetId) {
        return { kind: 'modification', stanza: stanza.toString(), securityContext: result.securityContext, authoredAt: result.authoredAt,
          modification: { type: 'retract', targetId: retraction.targetId } }
      }

      const fastening = stanza.getChild('apply-to', NS_FASTEN)
      const linkPreview = fastening && parseOgpFastening(fastening)
      if (fastening?.attrs.id && linkPreview) return {
        kind: 'modification', stanza: stanza.toString(), securityContext: result.securityContext, authoredAt: result.authoredAt,
        modification: { type: 'update', targetId: fastening.attrs.id, updates: { linkPreview }, authorOnly: false },
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
      const parsed = parseMessageContent({ messageEl: stanza, body, messageContext, authoredAt: result.authoredAt })
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

      const outcome: Extract<RetryOutcome, { kind: 'decrypted' }> = {
        kind: 'decrypted',
        ...(parsed.timestampSource === 'authored' && { authoredAt: parsed.timestamp }),
        body: processedBody,
        ...(securityContext && { securityContext }),
        ...(attachment && { attachment }),
        ...(unverified && { unverified: true as const }),
      }
      const correction = parseCorrectionSignal(stanza)
      if (correction?.targetId && archiveMessage && !archiveMessage.isEdited) {
        return {
          kind: 'modification', stanza: stanza.toString(), securityContext, authoredAt: outcome.authoredAt,
          modification: { type: 'update', targetId: correction.targetId, authorOnly: true, updates: {
            ...applyCorrection(stanza, body, '', { archiveId: archiveMessage.ownArchiveBy === scope.jid ? archiveMessage.ownArchiveId : undefined,
              delayEl: xml('delay', { xmlns: NS_DELAY, stamp: archiveMessage.timestamp.toISOString() }),
              authoredAt: outcome.authoredAt }), securityContext,
          } },
        }
      }
      const archiveIds = archiveMessage?.correctionRevision?.ids.filter(id => id.startsWith('stanza:')) ?? []
      if (messageContext === 'chat' && archiveMessage && correction?.targetId && archiveIds.length === 1 &&
          stores?.chat.rememberArchiveSignal) {
        scope.assertCurrent()
        if (manager !== this.deps.getManager() || stores !== this.deps.getStores()) return { kind: 'pending' }
        const signal: ArchiveSignal = {
          conversationId: peer, archiveId: archiveIds[0].slice('stanza:'.length),
          id: stanza.attrs.id ?? '', from: getBareJid(senderJid), stanza: stanza.toString(),
          timestamp: archiveMessage.correctionRevision?.archiveTimestamp ?? archiveMessage.timestamp.getTime(),
          authoredAt: outcome.authoredAt?.getTime(), securityContext,
          effect: { type: 'update', targetId: correction.targetId, authorOnly: true,
            updates: recoveredUpdates(archiveMessage, outcome, scope.jid) },
        }
        if (stores.chat.rememberArchiveSignalForRecovery) {
          if (!await stores.chat.rememberArchiveSignalForRecovery(signal, archiveMessage, scope.jid)) return { kind: 'pending' }
        } else {
          await stores.chat.rememberArchiveSignal(signal, scope.jid)
        }
      }
      return outcome
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

    const storageScope = captureStorageScope()
    const ownJid = this.deps.getOwnBareJid()
    const chatBindings = stores.chat
    await this.retryPendingMessages(peer)
    if (!storageScope.isCurrent() || this.deps.getOwnBareJid() !== ownJid ||
        this.deps.getManager() !== manager || this.deps.getStores() !== stores) return

    let updated = 0
    for (const msg of chatBindings.getConversationMessages(peer)) {
      if (msg.encryptedPayload) continue
      if (
        msg.securityContext?.trust === 'untrusted' &&
        msg.securityContext.notes?.some((n) => n.includes('not cached'))
      ) {
        chatBindings.updateMessage(peer, msg, {
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
