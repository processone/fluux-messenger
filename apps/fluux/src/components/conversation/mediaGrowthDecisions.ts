/**
 * Pure decision for what a settled media-load batch should do.
 *
 * Media decoding changes content height after the fact. A batch captures the reader's intent at its
 * START — were they at the live edge, and where were they reading — then applies exactly one
 * correction once decoding quiesces, so a run of images cannot produce a run of scroll writes.
 *
 * Value-only: no DOM, no controller, no timers.
 */

export interface MediaBatchSnapshotFacts {
  /** The reader was following the live edge when the batch began. */
  wasAtBottom: boolean
  /** A GENUINE user scroll landed during the batch — not a growth-driven event. */
  userScrolled: boolean
  /** A pre-growth reading anchor was captured. */
  hasAnchor: boolean
}

export type MediaBatchOutcome =
  /** Follow the live edge again: growth below the fold moved the newest message out of view. */
  | { kind: 'live-edge' }
  /** Media above the viewport grew and pushed the reading position down; put it back. */
  | { kind: 'preserve-anchor' }
  /** The reader moved during the batch. Their position is theirs; leave it alone. */
  | { kind: 'respect-user' }
  /** Nothing to correct and nothing captured to correct toward. */
  | { kind: 'none' }

export function decideMediaBatchOutcome(
  facts: MediaBatchSnapshotFacts,
): MediaBatchOutcome {
  if (facts.userScrolled) return { kind: 'respect-user' }
  if (facts.wasAtBottom) return { kind: 'live-edge' }
  return facts.hasAnchor ? { kind: 'preserve-anchor' } : { kind: 'none' }
}
