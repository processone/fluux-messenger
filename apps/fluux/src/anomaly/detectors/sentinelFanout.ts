/**
 * The anomaly side of the sentinel fan-out.
 *
 * Stage 2 adds NO detection logic. `reassertLoopMonitor`, `resizeLoopMonitor`,
 * `slowCorrectionMonitor` and `stallSentinel` already decide correctly and already
 * emit their prose; all that happens here is translating one of their observations
 * into a record. If this file ever starts deciding whether something is an anomaly,
 * the decision has escaped the monitor that owns it.
 *
 * The translation is where the privacy boundary is crossed, and it is one-way by
 * construction: the incoming signal carries plain numbers plus, in one case, a loop
 * label — and that label is mapped through a CLOSED table to a `TAG` constant. An
 * unrecognised label yields no ctx entry rather than reaching the record, so a new
 * loop kind added without a registry entry loses a detail, never leaks one.
 *
 * @module Anomaly/Detectors/SentinelFanout
 */
import type { ReassertLoopLabel } from '../../components/conversation/reassertLoopMonitor'
import type { AnomalySignal } from '../../utils/anomalySignal'
import type { RecordInput } from '../recorder'
import { CTX, ID, TAG, type Opaque } from '../values'

/**
 * Loop label to tag, EXHAUSTIVE over `ReassertLoopLabel`.
 *
 * The `Record<ReassertLoopLabel, …>` is the guarantee: adding a tenth loop kind to
 * the union fails to compile here until it gets a tag. An earlier version keyed
 * this on `string` and leaned on a test that grepped `useMessageListScroll.ts` for
 * literal call arguments — which silently stopped covering `media-anchor` and
 * the layout-preservation anchors the moment those started reaching `begin()` through
 * a variable. A type states the invariant the grep only approximated.
 *
 * The type import is erased at build time, so this adds no runtime edge from the
 * anomaly tree into the component tree.
 */
const LOOP_TAGS: Readonly<Record<ReassertLoopLabel, Opaque>> = Object.freeze({
  'pin-bottom': TAG.loopPinBottom,
  'media-anchor': TAG.loopMediaAnchor,
  'divider-anchor': TAG.loopDividerAnchor,
  'insertion-anchor': TAG.loopInsertionAnchor,
  prepend: TAG.loopPrepend,
  'restore-anchor': TAG.loopRestoreAnchor,
  marker: TAG.loopMarker,
  target: TAG.loopTarget,
  'resident-top': TAG.loopResidentTop,
})

/**
 * Look up a tag for a label that arrived as a plain string.
 *
 * The signal seam is deliberately dependency-free, so `label` is typed `string`
 * there and the runtime value could be anything. `Object.hasOwn` rather than a
 * truthiness check on the index, so an inherited property name cannot resolve.
 */
function loopTag(label: string): Opaque | undefined {
  return Object.hasOwn(LOOP_TAGS, label)
    ? LOOP_TAGS[label as ReassertLoopLabel]
    : undefined
}

/**
 * Translate one signal into a record.
 *
 * Exported separately from the handler so the mapping is testable without a
 * recorder, a sink or a tokenizer — the thing worth asserting is which id, which
 * severity and which numbers, not that a write happened.
 *
 * @returns the record to file, or `null` for a signal this build does not know.
 */
export function recordForSignal(signal: AnomalySignal): RecordInput | null {
  switch (signal.name) {
    case 'scroll/reassert-overlap':
      // `expected` is what a healthy run looks like — one loop — not the
      // threshold, which is the count at which the monitor starts complaining.
      // A reader comparing observed against a threshold learns nothing about how
      // far from correct the app was.
      return {
        id: ID.reassertOverlap,
        sev: 'bug',
        expected: 1,
        observed: signal.active,
        ctx: [],
      }

    case 'scroll/reassert-nonconverging': {
      const tag = loopTag(signal.label)
      return {
        id: ID.reassertNonConverging,
        sev: 'bug',
        expected: signal.threshold,
        observed: signal.writes,
        ctx: tag ? [[CTX.loop, tag]] : [],
      }
    }

    case 'scroll/resize-loop':
      // A fire count is meaningless without the window it was counted over, so
      // the window travels as ctx rather than being folded into the number.
      return {
        id: ID.resizeLoop,
        sev: 'suspect',
        expected: signal.threshold,
        observed: signal.fires,
        ctx: [[CTX.elapsedMs, signal.elapsedMs]],
      }

    case 'scroll/slow-correction':
      // The conversation is deliberately absent. It is in the prose line, but a
      // token here would have to pick between the `jid` and `room` namespaces and
      // the scroll hook has no conversation-type discriminator — guessing would
      // split one entity across two token spaces, which is worse than omitting it.
      return {
        id: ID.slowCorrection,
        sev: 'suspect',
        expected: signal.thresholdMs,
        observed: signal.durationMs,
        ctx: [[CTX.rows, signal.rows]],
      }

    case 'perf/main-thread-stall':
      // The route is deliberately absent: it carries the conversation JID.
      return {
        id: ID.mainThreadStall,
        sev: 'suspect',
        expected: signal.thresholdMs,
        observed: signal.blockedMs,
        ctx: [],
      }

    default:
      // Unreachable while the union and this switch agree. Reached only if a
      // signal is added without a case here, in which case dropping it is the
      // conservative outcome.
      return null
  }
}

/** Every invariant id this stage can produce, for the registry parity test. */
export const FANOUT_IDS: readonly Opaque[] = Object.freeze([
  ID.reassertOverlap,
  ID.reassertNonConverging,
  ID.resizeLoop,
  ID.slowCorrection,
  ID.mainThreadStall,
])

/** Loop labels this build knows how to attribute. */
export function knownLoopLabels(): string[] {
  return Object.keys(LOOP_TAGS)
}
