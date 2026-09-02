/**
 * A read pointer that moved backwards.
 *
 * The pointer is forward-only, and the direction it must never take is the
 * unrecoverable one: a position that slips back re-marks read messages as unread,
 * and nothing downstream can tell that from genuine new mail (#1076).
 *
 * "Forward-only" holds WITHIN one generation. An account switch, a logout, and
 * deleting a conversation all replace a pointer wholesale, so this detector resets
 * on the SDK's `ReadStateGeneration` rather than trying to recognise those
 * transitions from the pointer alone — reporting them would be the false positive
 * that costs a detector its life (design §6.1).
 *
 * @module Anomaly/Detectors/PointerRegression
 */
import type { ReadPointer, ReadStateGeneration } from '@fluux/sdk'
import type { RecordInput } from '../recorder'
import { CTX, ID, type Opaque } from '../values'

/** Bounded like every other detector: a diagnostic must not become the leak. */
const MAX_TRACKED = 300

export interface PointerObservation {
  kind: 'chat' | 'room'
  id: string
  pointer: ReadPointer | undefined
  generation: ReadStateGeneration
}

export interface PointerRegressionDetector {
  observe(observation: PointerObservation): void
  reset(): void
}

export interface PointerRegressionOptions {
  record: (input: RecordInput) => void
  token: (kind: 'chat' | 'room', id: string) => Opaque
  /**
   * The SDK's own ordering rule.
   *
   * Injected rather than imported so a caller cannot quietly substitute a
   * different comparison: a detector that re-derives the ordering would eventually
   * disagree with the store and report the disagreement as a bug in the store.
   */
  isAhead: (candidate: ReadPointer, current: ReadPointer | undefined) => boolean
  maxTracked?: number
}

interface Tracked {
  pointer: ReadPointer
  generation: ReadStateGeneration
}

function sameGeneration(a: ReadStateGeneration, b: ReadStateGeneration): boolean {
  return a.store === b.store && a.entity === b.entity
}

export function createPointerRegressionDetector(
  opts: PointerRegressionOptions
): PointerRegressionDetector {
  const maxTracked = opts.maxTracked ?? MAX_TRACKED
  const seen = new Map<string, Tracked>()

  return {
    observe({ kind, id, pointer, generation }) {
      const key = `${kind} ${id}`
      // A cleared pointer is a different event with a different cause, and the
      // ordering rule has no answer for "behind nothing". Forget the entity so the
      // next pointer it gets is a first observation rather than a comparison
      // against a position that no longer exists.
      if (!pointer) {
        seen.delete(key)
        return
      }

      const previous = seen.get(key)
      seen.set(key, { pointer, generation })
      while (seen.size > maxTracked) {
        const oldest = seen.keys().next()
        if (oldest.done) break
        seen.delete(oldest.value)
      }

      // No predecessor, or a predecessor from another generation: nothing this
      // pointer could legitimately be compared against.
      if (!previous || !sameGeneration(previous.generation, generation)) return

      // The question is whether what was ALREADY there is strictly ahead of what
      // was just written. Asking it in this direction is what makes an identical
      // rewrite silent: a tie is not an advance either way.
      if (!opts.isAhead(previous.pointer, pointer)) return

      opts.record({
        id: ID.pointerRegression,
        sev: 'bug',
        expected: 0,
        observed: 1,
        ctx: [
          [kind === 'room' ? CTX.room : CTX.conv, opts.token(kind, id)],
          [CTX.behindMs, previous.pointer.order.timestamp - pointer.order.timestamp],
        ],
      })
    },

    reset() {
      seen.clear()
    },
  }
}
