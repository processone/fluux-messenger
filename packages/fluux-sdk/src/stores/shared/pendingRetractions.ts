/**
 * Pending retractions (XEP-0424) — shared by the chat and room stores.
 *
 * A retraction can arrive while its target is not in the resident window: only
 * the ACTIVE conversation keeps its messages in RAM, and a target older than the
 * loaded slice is absent even there. The live path used to give up in that case,
 * which let the retraction's XEP-0428 fallback body fall through and surface as a
 * normal message. Instead the retraction is recorded here and replayed the moment
 * the target becomes resident (live arrival or a cache/MAM load), so the tombstone
 * lands late rather than never.
 *
 * @module
 */

import { findMessageIndexById } from '../../utils/messageLookup'

/** A retraction whose target was not resident when it arrived. */
export interface PendingRetraction {
  /** The `<retract id="…">` reference — any id tier of the target. */
  targetId: string
  /**
   * Author the retraction claims to come from. XEP-0424 only lets a message be
   * retracted by its own author, so this is re-checked when the target shows up.
   */
  actorJid: string
  /**
   * XEP-0421 occupant-id of the retracting author (MUC only). Preferred over
   * {@link actorJid} when the target carries one too — a nick can be reassigned
   * once its owner leaves, an occupant-id cannot.
   */
  actorOccupantId?: string
  /** Epoch ms the retraction was received; becomes the target's `retractedAt`. */
  retractedAt: number
}

/**
 * Per-conversation record cap. Records only clear when their target loads, so a
 * retraction for a message we never fetch would otherwise accumulate forever.
 */
export const PENDING_RETRACTION_CAP = 50

/** Minimum message shape the replay needs: the id tiers plus the tombstone fields. */
export interface RetractableMessage {
  id: string
  stanzaId?: string
  originId?: string
  correctionStanzaIds?: string[]
  isRetracted?: boolean
  retractedAt?: Date
}

/** Outcome of replaying a conversation's pending retractions against a slice. */
export interface PendingRetractionResult<T> {
  /** The patched array, or the input array itself when nothing changed. */
  messages: T[]
  /** Targets tombstoned by this pass — the caller writes these through to the cache. */
  applied: Array<{ messageId: string; retractedAt: Date }>
  /** Records whose target is still unknown; keep them for the next pass. */
  remaining: PendingRetraction[]
}

/**
 * Add a record, newest last. Idempotent per target, and capped so a retraction
 * targeting a message we never load cannot grow the list without bound.
 */
export function addPendingRetraction(
  list: PendingRetraction[],
  entry: PendingRetraction
): PendingRetraction[] {
  // Same array back when the target is already recorded, so callers can skip the
  // state write (a retraction re-delivered by carbons/MAM must not churn state).
  if (list.some((r) => r.targetId === entry.targetId)) return list
  return [...list, entry].slice(-PENDING_RETRACTION_CAP)
}

/**
 * Replay pending retractions against a message slice.
 *
 * A record resolves as soon as its target is present — applied when the author
 * matches, dropped otherwise (an unauthorized retraction must never tombstone,
 * and re-checking it on every load would be pure churn).
 */
export function applyPendingRetractions<T extends RetractableMessage>(
  messages: T[],
  pending: readonly PendingRetraction[],
  isAuthor: (message: T, record: PendingRetraction) => boolean
): PendingRetractionResult<T> {
  if (pending.length === 0) return { messages, applied: [], remaining: [] }

  const applied: PendingRetractionResult<T>['applied'] = []
  const remaining: PendingRetraction[] = []
  let patched: T[] | null = null

  for (const record of pending) {
    const source: T[] = patched ?? messages
    const index = findMessageIndexById(source, record.targetId)
    if (index === -1) {
      remaining.push(record)
      continue
    }

    const target = source[index]
    // Resolved either way from here: an unauthorized retraction is dropped, not
    // retried, and an already-tombstoned target needs no second write.
    if (target.isRetracted || !isAuthor(target, record)) continue

    const retractedAt = new Date(record.retractedAt)
    patched = [...source]
    patched[index] = { ...target, isRetracted: true, retractedAt }
    applied.push({ messageId: target.id, retractedAt })
  }

  return { messages: patched ?? messages, applied, remaining }
}
