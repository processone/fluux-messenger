/**
 * `read-state/unread-survives-focus` — an unread count that outlives being read.
 *
 * When a conversation is active, the window is focused, and the newest message is
 * actually on screen, the user is reading it. `useWindowVisibility` marks it read on
 * focus regain, so an unread count that persists in that state means the clearing
 * path did not run or did not stick.
 *
 * The "actually on screen" part is why this uses the VIEWPORT, not the SDK's
 * `windowAtLiveEdge`: the latter is true for any backgrounded conversation parked at
 * the tail, so it is not evidence anyone saw anything. See
 * `utils/viewportAtBottom.ts`.
 *
 * PURE: every input is passed in, including the clock. The detector holds only the
 * timestamp the condition began and which conversation it is watching.
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

export interface UnreadFocusVerdict {
  /** How long the condition had held when it was reported. */
  heldMs: number
  unreadCount: number
  active: { kind: 'conversation' | 'room'; id: string }
}

export interface UnreadSurvivesFocusDetector {
  /** Evaluate one sample. Returns a verdict at most once per episode. */
  observe(sample: UnreadFocusSample, now: number): UnreadFocusVerdict | null
}

/** How long the condition must hold continuously before it is reportable. */
const DEFAULT_HOLD_MS = 2000

export interface UnreadSurvivesFocusOptions {
  holdMs?: number
}

export function createUnreadSurvivesFocusDetector(
  opts: UnreadSurvivesFocusOptions = {},
): UnreadSurvivesFocusDetector {
  const holdMs = opts.holdMs ?? DEFAULT_HOLD_MS

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

  function reset(): void {
    watching = null
    since = null
    reported = null
  }

  return {
    observe(sample: UnreadFocusSample, now: number): UnreadFocusVerdict | null {
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
        reset()
        return null
      }

      const holds =
        sample.active !== null &&
        sample.focused &&
        sample.viewportAtBottom &&
        sample.unreadCount > 0

      if (!holds || sample.active === null) {
        reset()
        return null
      }

      const target = `${sample.active.kind}:${sample.active.id}`
      if (watching !== target) {
        // Switching conversations restarts the clock; the previous conversation's
        // elapsed time says nothing about this one.
        watching = target
        since = now
        reported = null
        return null
      }

      if (since === null) {
        since = now
        return null
      }

      const heldMs = now - since
      if (heldMs < holdMs) return null
      if (reported === target) return null

      reported = target
      return { heldMs, unreadCount: sample.unreadCount, active: sample.active }
    },
  }
}
