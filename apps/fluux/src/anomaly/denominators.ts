/**
 * The denominators, read from the stores rather than signalled by the app.
 *
 * A rate needs something that scales with USE to divide by, and both of these are
 * already visible in exported store state. Deriving them here rather than adding
 * call sites keeps two more seams out of production code for no loss of fidelity.
 *
 * @module Anomaly/Denominators
 */

export type DenominatorName = 'message.arrivals' | 'room.switches'

/** The slice of a store's state these denominators are derived from. */
export interface DenominatorSample {
  /** Newest arrival per conversation. NOT the message list — MAM backfill is absent. */
  lastArrivedMessage: ReadonlyMap<string, unknown>
  /** The conversation or room on screen, or null. */
  activeId: string | null
}

export interface DenominatorTracker {
  observe(next: DenominatorSample, prev: DenominatorSample): void
}

export function createDenominatorTracker(
  count: (name: DenominatorName) => void,
): DenominatorTracker {
  return {
    observe(next: DenominatorSample, prev: DenominatorSample): void {
      // `lastArrivedMessage` rather than the message map: the latter also grows by
      // MAM backfill, and a catch-up of two thousand rows would swamp the
      // denominator with messages nobody watched arrive — turning the rate it
      // divides into a measure of how much history was fetched.
      //
      // The reference check is the cheap gate. This subscription sees every store
      // publication — typing, presence, read-state — so walking the map each time
      // would cost far more than the arrivals it is looking for.
      if (next.lastArrivedMessage !== prev.lastArrivedMessage) {
        for (const [id, message] of next.lastArrivedMessage) {
          // Per ENTRY, not per map: the store rebuilds this map for unrelated
          // reasons, and identity alone would count arrivals that never happened.
          // A batch delivered to one conversation still counts once — the map holds
          // only the newest — so this measures arrival EVENTS, not messages.
          if (prev.lastArrivedMessage.get(id) !== message) count('message.arrivals')
        }
      }

      // Only an arrival AT a conversation. Closing the last one leaves for the empty
      // state, which is not navigation between conversations, and counting it would
      // credit the teardown render burst to a switch that never happened.
      if (next.activeId !== null && next.activeId !== prev.activeId) count('room.switches')
    },
  }
}
