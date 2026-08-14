/**
 * Why an unread recount declined to commit.
 *
 * `recomputeUnreadForRoom` and `recomputeUnreadForConversation` are a chain of
 * about twenty guards, most of which defer rather than count. Every one of them is
 * correct in isolation — an uncertain count is worse than a stale one — but from
 * outside the store they are indistinguishable: the badge simply keeps its old
 * value, and nothing says which guard stood down or how often.
 *
 * That gap is issue #1211, where a MUC badge stays up while its room is open and
 * clears only on switching away. Two guards are plausible causes and neither is
 * observable, so the bug cannot be attributed without guessing.
 *
 * This is a COUNTER, not a log: it records reasons and tallies, never entity ids,
 * message ids or unread totals. Nothing here can identify a conversation, so the
 * tallies are safe to read from anywhere and safe to write to a diagnostic sidecar.
 *
 * It is deliberately passive. Nothing in the store reads these numbers back, so a
 * miscount can change no behaviour.
 *
 * @module Stores/Shared/RecountDiagnostics
 */

/**
 * The distinct ways a recount can end without committing.
 *
 * A closed union so a new guard cannot be added silently: adding one means naming
 * it here, and a name is what makes the tally readable.
 */
export type RecountDeferralReason =
  /** Skipped because the entity is active and the caller did not opt in. */
  | 'active-skipped'
  /** No metadata for the entity — nothing to correct. */
  | 'no-meta'
  /** No read position was ever established, and a bare zero cannot be trusted. */
  | 'pointerless-defer'
  /** A remote XEP-0490 position is still being resolved. */
  | 'pending-remote-displayed'
  /** Neither a read pointer nor a history floor to count from. */
  | 'no-floor'
  /** History has not caught up, so any count would be derived from partial history. */
  | 'history-not-caught-up'
  /** Cache epoch or storage scope moved under this recount. */
  | 'context-changed'
  /** No coverage record for the entity, so the archive bottom is unknown. */
  | 'coverage-missing'
  /** A coverage record exists but its bottom no longer resolves in the archive. */
  | 'coverage-unresolvable'
  /** Coverage does not reach back to the floor, so the count would under-report. */
  | 'coverage-short-of-floor'
  /** The archive count itself was unavailable — an IndexedDB error. */
  | 'cache-unavailable'
  /** Another recount for the same entity started while this one was awaiting. */
  | 'recount-superseded'
  /**
   * Message inputs changed while this recount was awaiting, so its result describes
   * a state that no longer exists.
   *
   * The interesting one for #1211: `addMessage` bumps this version on EVERY
   * arrival, so an active room that keeps receiving can invalidate each recount
   * with the traffic that made it necessary.
   */
  | 'input-version-changed'
  /** The read pointer moved while the recount was in flight. */
  | 'pointer-changed'

export type RecountEntityKind = 'chat' | 'room'

const tallies = new Map<string, number>()

function key(kind: RecountEntityKind, reason: RecountDeferralReason): string {
  return `${kind}:${reason}`
}

/** Record one deferral. Cheap enough for the hot path; no allocation beyond the key. */
export function recordRecountDeferral(
  kind: RecountEntityKind,
  reason: RecountDeferralReason,
): void {
  const k = key(kind, reason)
  tallies.set(k, (tallies.get(k) ?? 0) + 1)
}

/**
 * A snapshot of the tallies so far, keyed `<kind>:<reason>`.
 *
 * CUMULATIVE for the process — a caller wanting per-window figures must diff
 * against its own previous read, which is what the anomaly digest already does for
 * its other health counters. Returning a copy so a reader cannot mutate the source.
 */
export function readRecountDeferrals(): Record<string, number> {
  return Object.fromEntries(tallies)
}

/** Test-only. */
export function resetRecountDeferralsForTesting(): void {
  tallies.clear()
}
