/**
 * The "a pin-bottom loop already owns the bottom" claim.
 *
 * Two callers skip their own work while a pin loop is in flight: the row-growth re-pin (it would
 * only stack a second loop — the running one re-reads scrollHeight every frame and picks the growth
 * up itself, and restarting costs a synchronous forced layout + repaint, the WebKitGTK hot path),
 * and the scroll-to-bottom FAB (a growth-driven scroll event fires at the pre-repin scrollTop, which
 * would flash the FAB while the loop is settling AT the bottom).
 *
 * Held as a DEADLINE, not a boolean. The leased frame-loop adapter now releases the claim on every
 * normal terminal path, including a stale lease and thrown controller frame work. The deadline
 * remains defense in depth for a browser or scheduler failure that prevents the queued callback from
 * running at all. A running loop renews the claim on every frame, so a claim with no frame for this
 * long heals itself instead of wedging the list.
 *
 * The failure mode of expiring too early is benign and self-correcting: one extra pin loop, which
 * supersedes the stale one and re-pins an already-pinned bottom.
 */

/** Defense-in-depth lifetime without a loop frame. Well past any healthy frame gap. */
export const PIN_CLAIM_STALE_MS = 2000

export interface PinLoopClaim {
  /** Take (or renew) the claim. Called when the loop starts and on every frame it runs. */
  renew: () => void
  /** Drop the claim — the loop finished. */
  release: () => void
  /** Whether a loop currently owns the bottom. */
  isHeld: () => boolean
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
  }
}
