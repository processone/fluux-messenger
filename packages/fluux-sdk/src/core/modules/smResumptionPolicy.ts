/**
 * Stream Management resumption policy (XEP-0198).
 *
 * One place decides how long a session may be resumed and whether a saved
 * session is still eligible, so the connection state machine, the in-memory
 * cache and the persisted record cannot disagree.
 */

/** Default request, and the fallback when the server's `max` is missing or malformed (10 minutes). */
export const DEFAULT_SM_MAX_SECONDS = 600

/**
 * Validate the configured resumption request (seconds).
 * Returns the default when unset; throws on anything but a positive safe integer.
 */
export function resolveSmRequestSeconds(configured: number | undefined): number {
  if (configured === undefined) return DEFAULT_SM_MAX_SECONDS
  if (!Number.isSafeInteger(configured) || configured <= 0) {
    throw new Error(
      `streamManagementMaxSeconds must be a positive integer number of seconds (got ${String(configured)})`
    )
  }
  return configured
}

/**
 * Resumption window (ms) for a session the server just enabled.
 *
 * A valid advertised `max` is capped at what we asked for. A missing or
 * malformed `max` falls back to ten minutes, also capped at the request.
 */
export function resolveSmWindowMs(requestSeconds: number, advertised: unknown): number {
  const parsed = typeof advertised === 'string' && advertised.trim() !== '' ? Number(advertised) : advertised
  const valid = typeof parsed === 'number' && Number.isFinite(parsed) && parsed >= 1
  const seconds = valid ? Math.min(requestSeconds, Math.floor(parsed)) : Math.min(requestSeconds, DEFAULT_SM_MAX_SECONDS)
  return seconds * 1000
}

/**
 * Whether a session interrupted at `anchorMs` may still be resumed at `nowMs`.
 * The exact deadline is expired; an unusable or future anchor is never eligible.
 */
export function isWithinSmWindow(anchorMs: number, nowMs: number, windowMs: number): boolean {
  if (!Number.isFinite(anchorMs) || !Number.isFinite(windowMs) || anchorMs > nowMs) return false
  return nowMs - anchorMs < windowMs
}
