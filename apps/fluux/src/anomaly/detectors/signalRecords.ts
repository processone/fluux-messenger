/**
 * Signal to record: the single translation point between an observation and a line
 * in the log.
 *
 * NO decision logic lives here, and none ever should. Two kinds of caller feed it and
 * both have already decided: the always-shipped monitors (`reassertLoopMonitor`,
 * `resizeLoopMonitor`, `slowCorrectionMonitor`, `stallSentinel`), which also emit
 * their own prose; and the dev-only detectors in this directory, each a pure function
 * with its own tests. If this file ever starts deciding whether something is an
 * anomaly, the decision has escaped the module that owns it.
 *
 * The translation is where the privacy boundary is crossed, and it is one-way by
 * construction. A signal carries plain numbers plus, in a few cases, a caller string:
 * a loop label, a conversation id, a message id. None reaches the record as itself —
 * the label goes through a CLOSED table to a `TAG`, and the ids through the HMAC
 * tokenizer or the session-local ref map. An unmapped label yields no ctx entry
 * rather than passing through, so a new loop kind loses a detail, never leaks one.
 *
 * @module Anomaly/Detectors/SignalRecords
 */
import type { ReassertLoopLabel } from '../../components/conversation/reassertLoopMonitor'
import type { AnomalySignal } from '../../utils/anomalySignal'
import { convToken, messageRef, roomToken } from '../identity'
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

    case 'recorder/entity-warm-failing':
      // About the LOG, not the app — hence the `recorder/` family. Records are still
      // being written for this conversation; they simply name `c:unresolved` and
      // cannot be correlated, so the instrument is degraded rather than the client.
      //
      // No ctx: the only context worth having is which conversation, and the token
      // for it is precisely what is failing to resolve.
      return {
        id: ID.entityWarmFailing,
        sev: 'suspect',
        expected: 0,
        observed: signal.consecutiveFailures,
        ctx: [],
      }

    case 'read-state/unread-survives-focus':
      // `suspect`, not `bug`, on its first outing: the app marks read on focus
      // regain, so a count lingering for the hold window is more likely a
      // propagation delay than a broken invariant. `bug` has to keep meaning "an
      // invariant broke" or it stops meaning anything.
      //
      // The conversation IS recorded here, unlike slow-correction: this signal
      // carries its kind, so the token lands in the right namespace instead of
      // splitting one entity across two.
      return {
        id: ID.unreadSurvivesFocus,
        sev: 'suspect',
        expected: 0,
        observed: signal.unreadCount,
        ctx: [
          signal.kind === 'room'
            ? [CTX.room, roomToken(signal.id)]
            : [CTX.conv, convToken(signal.id)],
          [CTX.heldMs, signal.heldMs],
        ],
      }

    case 'read-state/unread-persists':
      // `bug`, where the 2s record is only `suspect`. After this long with the user
      // looking straight at the message, a mark-read that has not landed is not a
      // propagation delay — it did not happen.
      return {
        id: ID.unreadPersists,
        sev: 'bug',
        expected: 0,
        observed: signal.heldMs,
        ctx: [
          signal.kind === 'room'
            ? [CTX.room, roomToken(signal.id)]
            : [CTX.conv, convToken(signal.id)],
          [CTX.peak, signal.peakUnread],
        ],
      }

    case 'read-state/unread-focus-cleared':
      // `drift`, not `suspect`: this is the MEASUREMENT that closes an episode the
      // `suspect` record already opened, not a second complaint about it. Pairing the
      // two by conversation gives the observed recovery time; `unread-persists` is the
      // separate proof that the count stayed wrong. No close record means only that
      // recovery was not observed.
      return {
        id: ID.unreadFocusCleared,
        sev: 'drift',
        expected: 0,
        observed: signal.heldMs,
        ctx: [
          signal.kind === 'room'
            ? [CTX.room, roomToken(signal.id)]
            : [CTX.conv, convToken(signal.id)],
          [CTX.peak, signal.peakUnread],
        ],
      }

    case 'scroll/fab-at-live-edge':
      // `expected: 0` reads as "no FAB while at the live edge". The observed value
      // is the independently measured distance, which is what makes the record
      // reviewable: a reader can see how far from the bottom the app actually was.
      return {
        id: ID.fabAtLiveEdge,
        sev: 'bug',
        expected: 0,
        observed: signal.distFromBottom,
        ctx: [[CTX.heldMs, signal.heldMs]],
      }

    case 'scroll/live-edge-pin-short':
      // `expected: 0` reads as "nothing left between the reader and the newest
      // message after a pin that reported itself settled". `observed` is the
      // shortfall, which is what makes the record reviewable.
      return {
        id: ID.liveEdgePinShort,
        sev: 'suspect',
        expected: 0,
        observed: signal.distFromBottom,
        ctx: [[CTX.heldMs, signal.heldMs]],
      }

    case 'scroll/jump-target-miss': {
      // A session-local ref, not a token: a message id is seen once, so hashing it
      // into the cross-session space would fill the cache with singletons and
      // resolve to the unresolved sentinel anyway.
      const ref = messageRef(signal.messageId)
      return {
        id: ID.jumpTargetMiss,
        sev: 'bug',
        expected: true,
        observed: false,
        // `null` under ref pressure: omit the message rather than substitute
        // anything for it.
        ctx: ref ? [[CTX.msg, ref], [CTX.offBy, signal.offBy]] : [[CTX.offBy, signal.offBy]],
      }
    }

    default:
      // Unreachable while the union and this switch agree. Reached only if a
      // signal is added without a case here, in which case dropping it is the
      // conservative outcome.
      return null
  }
}

/**
 * Every invariant id this mapping can produce.
 *
 * Closes the third link of the parity chain: `values.test.ts` ties `ID` to the
 * registry document, and `signalRecords.test.ts` ties this list to what the switch
 * above actually returns. Without it an id could be declared and documented while
 * being unreachable — a registry row for something that can never appear.
 */
export const FANOUT_IDS: readonly Opaque[] = Object.freeze([
  ID.entityWarmFailing,
  ID.reassertOverlap,
  ID.reassertNonConverging,
  ID.resizeLoop,
  ID.slowCorrection,
  ID.mainThreadStall,
  ID.unreadSurvivesFocus,
  ID.unreadPersists,
  ID.unreadFocusCleared,
  ID.fabAtLiveEdge,
  ID.liveEdgePinShort,
  ID.jumpTargetMiss,
])

/** Loop labels this build knows how to attribute. */
export function knownLoopLabels(): string[] {
  return Object.keys(LOOP_TAGS)
}
