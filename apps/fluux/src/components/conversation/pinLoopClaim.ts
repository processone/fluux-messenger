/**
 * The "a pin-bottom loop already owns the bottom" claim.
 *
 * Two callers skip their own work while a pin loop is in flight: the row-growth re-pin (it would
 * only stack a second loop — the running one re-reads scrollHeight every frame and picks the growth
 * up itself, and restarting costs a synchronous forced layout + repaint, the WebKitGTK hot path),
 * and the scroll-to-bottom FAB (a growth-driven scroll event fires at the pre-repin scrollTop, which
 * would flash the FAB while the loop is settling AT the bottom).
 *
 * Held as a DEADLINE, not a boolean. A boolean is cleared only by the loop's finish callback, so any
 * path that drops a loop without finishing it — a lease that silently stops being current mid-flight
 * — latches the claim forever. A latched claim silently suppresses EVERY later bottom re-pin (a
 * link-preview fastening, an attachment, a reaction) for the whole life of that mounted list, which
 * is exactly the "it never sticks to the bottom" report. A running loop renews the claim on every
 * frame, so a claim that has gone this long without one is provably stale and heals itself instead
 * of wedging the list.
 *
 * The failure mode of expiring too early is benign and self-correcting: one extra pin loop, which
 * supersedes the stale one and re-pins an already-pinned bottom.
 */

/** How long a claim survives without a loop frame renewing it. Well past any real frame gap. */
export const PIN_CLAIM_STALE_MS = 2000

export interface PinLoopClaim {
  /** Take (or renew) the claim. Called when the loop starts and on every frame it runs. */
  renew: () => void
  /** Drop the claim — the loop finished. */
  release: () => void
  /** Whether a loop currently owns the bottom. */
  isHeld: () => boolean
  /**
   * Milliseconds until the claim lapses if nothing renews it (0 when not held). A caller that had
   * to defer because the claim was held uses this to schedule its retry: the claim cannot outlive
   * this window without a live loop renewing it, so the retry either finds it released or finds a
   * loop that is genuinely still pinning.
   */
  msUntilExpiry: () => number
}

export function createPinLoopClaim(now: () => number = Date.now): PinLoopClaim {
  let heldUntil = 0
  return {
    renew: () => {
      heldUntil = now() + PIN_CLAIM_STALE_MS
    },
    release: () => {
      heldUntil = 0
    },
    isHeld: () => heldUntil > now(),
    msUntilExpiry: () => Math.max(0, heldUntil - now()),
  }
}
