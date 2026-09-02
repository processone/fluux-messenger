/**
 * Pending retractions (XEP-0424) — shared by the chat and room stores.
 *
 * A retraction can arrive while its target is not in the resident window: a
 * deactivated conversation has been evicted, and a target older than the loaded
 * slice is absent even in a populated window. Giving up in that case would let the
 * retraction's XEP-0428 fallback body fall through and surface as a normal
 * message. Instead the retraction is recorded here and replayed the moment
 * the target becomes resident (live arrival or a cache/MAM load), so the tombstone
 * lands late rather than never.
 *
 * @module
 */

import { resolveMessageReference, type IdentityFields, type MessageActor } from '../../utils/messageIdentity'

/** The identity tiers {@link applyPendingRetractions} resolves a reference through. */
type IdentityProbeFields = Pick<IdentityFields, 'id' | 'stanzaId' | 'originId' | 'correctionStanzaIds'>

/** A retraction whose target was not resident when it arrived. */
export interface PendingRetraction extends MessageActor {
  /** The `<retract id="…">` reference — any id tier of the target. */
  targetId: string
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
  /** Author-resolved targets that need durable cache/index cleanup. */
  resolved: Array<{ message: T; retractedAt: Date }>
  /** Records whose target is still unknown; keep them for the next pass. */
  remaining: PendingRetraction[]
}

/**
 * Add a record, newest last. Idempotent per target and actor, and capped so
 * retractions targeting messages we never load cannot grow the list without
 * bound.
 */
export function addPendingRetraction(
  list: PendingRetraction[],
  entry: PendingRetraction
): PendingRetraction[] {
  const duplicateIndex = list.findIndex(
    (record) =>
      record.targetId === entry.targetId &&
      record.actorJid === entry.actorJid &&
      record.actorOccupantId === entry.actorOccupantId
  )
  if (duplicateIndex !== -1) {
    if (list[duplicateIndex].retractedAt <= entry.retractedAt) return list
    const next = [...list]
    next[duplicateIndex] = entry
    return next
  }
  return [...list, entry].slice(-PENDING_RETRACTION_CAP)
}

export function removePendingRetraction(
  list: PendingRetraction[],
  entry: PendingRetraction
): PendingRetraction[] {
  const remaining = list.filter((record) =>
    record.targetId !== entry.targetId ||
    record.actorJid !== entry.actorJid ||
    record.actorOccupantId !== entry.actorOccupantId
  )
  return remaining.length === list.length ? list : remaining
}

/**
 * Replay pending retractions against a message slice.
 *
 * A record resolves only when an author-matching target is present. A lower-tier
 * identity collision can surface an unrelated message first, so an unauthorized
 * candidate remains pending for a later authoritative match.
 *
 * The ladder is not a parameter: a caller that could supply its own resolver could
 * supply a weaker one. Chat and room slices resolve identically here — the room
 * scoping that separates them lives in the durable keys, and a resident slice is
 * already one conversation's.
 */
export function applyPendingRetractions<T extends RetractableMessage & IdentityProbeFields>(
  messages: T[],
  pending: readonly PendingRetraction[],
  isAuthor: (message: T, record: PendingRetraction) => boolean
): PendingRetractionResult<T> {
  if (pending.length === 0) return { messages, applied: [], resolved: [], remaining: [] }

  const applied = new Map<number, Date>()
  const resolved = new Map<number, Date>()
  const remaining: PendingRetraction[] = []
  let patched: T[] | null = null

  const byReference = new Map<string, PendingRetraction[]>()
  for (const record of pending) {
    const records = byReference.get(record.targetId)
    if (records) records.push(record)
    else byReference.set(record.targetId, [record])
  }

  for (const [reference, records] of byReference) {
    const source: T[] = patched ?? messages
    const resolution = resolveMessageReference(source, reference, 'archive-first')
    if (!resolution) {
      remaining.push(...records)
      continue
    }

    const consumed = new Set<PendingRetraction>()
    for (const candidate of resolution.candidates) {
      const index = candidate.index
      const target = (patched ?? messages)[index]
      const authorized = records.filter((record) => isAuthor(target, record))
      if (authorized.length === 0) continue
      for (const record of authorized) consumed.add(record)

      const receivedAt = Math.min(...authorized.map((record) => record.retractedAt))
      const retractedAt = target.retractedAt && target.retractedAt.getTime() <= receivedAt
        ? target.retractedAt
        : new Date(receivedAt)
      const knownResolved = resolved.get(index)
      if (!knownResolved || retractedAt < knownResolved) resolved.set(index, retractedAt)
      if (target.isRetracted && !applied.has(index)) continue
      if (target.isRetracted && target.retractedAt?.getTime() === retractedAt.getTime()) continue

      const next: T[] = [...(patched ?? messages)]
      next[index] = { ...target, isRetracted: true, retractedAt }
      patched = next
      const knownApplied = applied.get(index)
      if (!knownApplied || retractedAt < knownApplied) applied.set(index, retractedAt)
    }
    if (!resolution.authoritative) {
      remaining.push(...records.filter((record) => !consumed.has(record)))
    }
  }

  return {
    messages: patched ?? messages,
    applied: [...applied].map(([index, retractedAt]) => ({
      messageId: (patched ?? messages)[index].id,
      retractedAt,
    })),
    resolved: [...resolved].map(([index, retractedAt]) => ({
      message: (patched ?? messages)[index],
      retractedAt,
    })),
    remaining,
  }
}


