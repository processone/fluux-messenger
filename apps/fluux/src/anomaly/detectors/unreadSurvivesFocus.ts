/**
 * `read-state/unread-survives-focus` — an unread count that outlives being read.
 *
 * When a conversation is active, the window is focused, the loaded message window is
 * at the archive tail, and the viewport is at its bottom, the user is reading the
 * newest message. `useWindowVisibility` marks it read on focus regain, so an unread
 * count that persists in that state means the clearing path did not run or did not
 * stick.
 *
 * Both position signals are required. `windowAtLiveEdge` alone is true for any
 * backgrounded conversation parked at the tail, while `viewportAtBottom` alone can be
 * true at the bottom of a resident slice that has newer messages beyond it.
 *
 * PURE: every input is passed in, including the clock. The detector retains only the
 * current episode's timing, identity, scope, peak count and reporting state.
 *
 * @module Anomaly/Detectors/UnreadSurvivesFocus
 */

/** Everything the verdict depends on, sampled at one instant. */
export interface UnreadFocusSample {
  /** Active conversation, or null when none is open. */
  active: { kind: 'conversation' | 'room'; id: string } | null
  /** Is the app window focused AND visible. */
  focused: boolean
  /** Is the newest message actually on screen — viewport truth, not window truth. */
  viewportAtBottom: boolean
  /** Is the loaded message window at the tail of the archive. */
  windowAtLiveEdge: boolean
  /** The canonical unread count for the active conversation. */
  unreadCount: number
  /**
   * Account / storage scope.
   *
   * The ONLY generation-ish signal publicly observable before stage 5. A change
   * means the store was rebuilt under us, so any pending observation is void.
   */
  scopeKey: string
}

/**
 * One episode produces up to three verdicts, and the distinction between them is the
 * whole point.
 *
 * `held` fires the moment the threshold is crossed — "this is going wrong now".
 *
 * `persisted` fires if the condition is STILL true much later. This is what separates
 * a badge that lagged a moment from one that stayed wrong, and it does so WITHOUT
 * needing to witness the recovery — which matters, because this app marks read on a
 * focus change or a tab switch, so the badge may routinely clear only once the user
 * has navigated away, exactly when nothing is watching.
 *
 * `cleared` fires only when the count genuinely reaches zero while the conversation is
 * still active, focused and at the live edge. It is the sole case where a real duration
 * is knowable.
 *
 * Losing sight of the episode any other way — focus lost, viewport moved, conversation
 * switched, store rebuilt — ends it SILENTLY. An earlier revision reported those as
 * `cleared`, which measured how long the detector could watch rather than how long the
 * badge was wrong, and named a recovery that had not happened.
 */
export type UnreadFocusVerdict =
  | {
      kind: 'held'
      /** Time since the condition began — barely past the threshold, by construction. */
      heldMs: number
      unreadCount: number
      active: { kind: 'conversation' | 'room'; id: string }
    }
  | {
      kind: 'persisted'
      /** How long it had held when it proved persistent. */
      heldMs: number
      /** The highest unread count seen so far this episode. */
      peakUnread: number
      active: { kind: 'conversation' | 'room'; id: string }
    }
  | {
      kind: 'cleared'
      /** How long the condition ACTUALLY lasted, end to end. */
      heldMs: number
      /** The highest unread count seen during the episode. */
      peakUnread: number
      active: { kind: 'conversation' | 'room'; id: string }
    }

export interface UnreadSurvivesFocusDetector {
  /**
   * Evaluate one sample.
   *
   * At most one verdict per call. A genuine observed recovery can return `cleared`;
   * losing sight of an episode resets it silently.
   */
  observe(sample: UnreadFocusSample, now: number): UnreadFocusVerdict | null
}

/** How long the condition must hold continuously before it is reportable. */
const DEFAULT_HOLD_MS = 2000
/**
 * How long before "still wrong" stops being a plausible propagation delay.
 *
 * Well past any settle: a mark-read that has not landed after half a minute of the
 * user looking straight at the message is not lagging, it did not happen.
 */
const DEFAULT_PERSIST_MS = 30_000
/** Largest observed interval that still counts as continuous sampling. */
const DEFAULT_MAX_SAMPLE_GAP_MS = 5_000

export interface UnreadSurvivesFocusOptions {
  holdMs?: number
  persistMs?: number
  maxSampleGapMs?: number
}

export function createUnreadSurvivesFocusDetector(
  opts: UnreadSurvivesFocusOptions = {},
): UnreadSurvivesFocusDetector {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS
  const persistMs = opts.persistMs ?? DEFAULT_PERSIST_MS
  const maxSampleGapMs = opts.maxSampleGapMs ?? DEFAULT_MAX_SAMPLE_GAP_MS

  /** The conversation currently under observation, as `kind:id`. */
  let watching: string | null = null
  let since: number | null = null
  let scope: string | null = null
  /**
   * Episodes already reported, so one stuck badge produces one record rather than
   * one per tick. Cleared whenever the condition breaks, so a LATER recurrence on
   * the same conversation is still reported — the recorder's per-id cooldown is what
   * bounds frequency, and suppressing forever would hide a regression.
   */
  let reported: string | null = null
  /** The conversation `reported` refers to, preserved for a genuine observed recovery. */
  let reportedActive: { kind: 'conversation' | 'room'; id: string } | null = null
  /** Worst count seen this episode — a badge that grew while watched says more. */
  let peakUnread = 0
  /** Whether this episode has already been reported as persistent. */
  let escalated = false
  let lastSampleAt: number | null = null

  /**
   * End the current episode, reporting its true duration only for an observed recovery.
   *
   * Returns the verdict rather than emitting, so every reset path clears the same
   * state. Anything other than a genuine recovery closes silently because its outcome
   * is unknown.
   */
  function endEpisode(now: number, recovered: boolean): UnreadFocusVerdict | null {
    const verdict: UnreadFocusVerdict | null =
      recovered && reported !== null && reportedActive !== null && since !== null
        ? { kind: 'cleared', heldMs: now - since, peakUnread, active: reportedActive }
        : null
    watching = null
    since = null
    reported = null
    reportedActive = null
    peakUnread = 0
    escalated = false
    return verdict
  }

  return {
    observe(sample: UnreadFocusSample, now: number): UnreadFocusVerdict | null {
      const sampleGap = lastSampleAt === null ? null : now - lastSampleAt
      lastSampleAt = now
      if (
        sampleGap !== null &&
        (!Number.isFinite(sampleGap) || sampleGap < 0 || sampleGap > maxSampleGapMs)
      ) {
        endEpisode(now, false)
      }

      // A scope CHANGE means the store was rebuilt. Drop everything: an observation
      // spanning the rebuild describes two different worlds.
      //
      // Adopting the first scope is not a change. Treating it as one made the very
      // first sample reset the detector, so every episode started its clock a tick
      // late and the hold window was effectively one tick longer than configured.
      if (scope === null) {
        scope = sample.scopeKey
      } else if (scope !== sample.scopeKey) {
        scope = sample.scopeKey
        // The store was rebuilt. Whatever became of the badge is now unknowable, so
        // the episode ends without claiming a recovery.
        return endEpisode(now, false)
      }

      const holds =
        sample.active !== null &&
        sample.focused &&
        sample.viewportAtBottom &&
        sample.windowAtLiveEdge &&
        sample.unreadCount > 0

      if (!holds || sample.active === null) {
        // A GENUINE recovery is the one case worth a duration: the count reached zero
        // while the user was still looking at the conversation. Everything else —
        // focus lost, scrolled away, switched conversation — merely ends the
        // observation, and reporting it as a clear would name a recovery that may
        // never have happened.
        const recovered =
          sample.active !== null &&
          sample.focused &&
          sample.viewportAtBottom &&
          sample.windowAtLiveEdge &&
          sample.unreadCount === 0 &&
          watching === `${sample.active.kind}:${sample.active.id}`
        return endEpisode(now, recovered)
      }

      const target = `${sample.active.kind}:${sample.active.id}`
      if (watching !== target) {
        // Switching conversations restarts the clock; the previous conversation's
        // elapsed time says nothing about this one, and the switch reveals nothing
        // about whether its badge recovered.
        const closing = endEpisode(now, false)
        watching = target
        since = now
        peakUnread = sample.unreadCount
        return closing
      }

      peakUnread = Math.max(peakUnread, sample.unreadCount)

      if (since === null) {
        since = now
        return null
      }

      const heldMs = now - since
      if (heldMs < holdMs) return null

      if (reported !== target) {
        reported = target
        reportedActive = sample.active
        return { kind: 'held', heldMs, unreadCount: sample.unreadCount, active: sample.active }
      }

      // Still true much later. Reported once, and independently of ever seeing the
      // recovery — which is what makes the "lagged or stuck" question answerable at
      // all when the badge only clears after the user has looked away.
      if (!escalated && heldMs >= persistMs) {
        escalated = true
        return { kind: 'persisted', heldMs, peakUnread, active: sample.active }
      }

      return null
    },
  }
}
