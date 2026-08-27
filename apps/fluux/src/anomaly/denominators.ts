/**
 * Store transitions, read rather than signalled.
 *
 * Two consumers, one detection. A rate needs something that scales with USE to
 * divide by, and a record needs to say what was happening just before it — and both
 * arrivals and activations answer both questions. Detecting them once here keeps the
 * seams out of production code entirely: nothing in the app calls into this.
 *
 * @module Anomaly/Denominators
 */
import type { Scalar } from './serializer'
import { convToken, roomToken } from './identity'
import { TAG } from './values'

export type DenominatorName =
  | 'message.arrivals.conversation'
  | 'message.arrivals.room'
  | 'room.switches'

interface ArrivedMessage {
  readonly isOutgoing?: boolean
}

/** The slice of a store's state an arrival denominator is derived from. */
export interface ArrivalSample {
  /** Newest arrival per conversation or room. NOT the message list — MAM backfill is absent. */
  lastArrivedMessage: ReadonlyMap<string, ArrivedMessage>
  /** Which token namespace the map keys belong to. */
  isRoom: boolean
}

export interface ActiveEntity {
  kind: 'conversation' | 'room'
  id: string
}

export interface DenominatorTracker {
  observeArrivals(next: ArrivalSample, prev: ArrivalSample): void
  observeActive(next: ActiveEntity | null, prev: ActiveEntity | null): void
}

/**
 * Report a transition to the breadcrumb ring.
 *
 * Optional because counting and remembering are independent: a caller that only
 * needs denominators should not have to supply a sink for crumbs it will not read.
 */
export type CrumbSink = (parts: Scalar[]) => void

export function createDenominatorTracker(
  count: (name: DenominatorName) => void,
  crumb?: CrumbSink,
): DenominatorTracker {
  // An id alone cannot say which namespace it belongs to, and the two token spaces
  // are deliberately separate, so the kind is decided by which map moved.
  const drop = (parts: Scalar[]): void => crumb?.(parts)

  return {
    observeArrivals(next: ArrivalSample, prev: ArrivalSample): void {
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
          // A batch delivered to one entity still counts once — the map holds
          // only the newest — so this measures arrival EVENTS, not messages.
          if (prev.lastArrivedMessage.get(id) === message) continue
          count(next.isRoom ? 'message.arrivals.room' : 'message.arrivals.conversation')
          // A token, never the JID. A crumb is written to the same file as every
          // other value and is bound by the same rule.
          drop([
            message.isOutgoing ? TAG.msgOut : TAG.msgIn,
            next.isRoom ? roomToken(id) : convToken(id),
          ])
        }
      }
    },

    observeActive(next: ActiveEntity | null, prev: ActiveEntity | null): void {
      if (next?.kind === prev?.kind && next?.id === prev?.id) return
      // Only an activation AT an entity. Closing the last one leaves for the empty
      // state, which is not navigation between conversations, and counting it would
      // credit the teardown render burst to a switch that never happened.
      if (next !== null) {
        count('room.switches')
        drop([TAG.activate, next.kind === 'room' ? roomToken(next.id) : convToken(next.id)])
        return
      }
      // Closing IS worth a crumb even though it is not a denominator: the teardown
      // is a real burst of work, and a freeze right after it should show what led in.
      drop([TAG.deactivate])
    },
  }
}
