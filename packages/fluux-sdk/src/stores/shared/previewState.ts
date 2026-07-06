/**
 * The single sidebar-preview policy applied after a bulk merge (a MAM page or
 * an IndexedDB cache slice) — shared by chatStore and roomStore.
 *
 * The candidate (newest previewable message in the merged set; rooms
 * additionally skip ignored senders via their own scanner) replaces the
 * current preview only when it genuinely supersedes it:
 *
 * - there is no existing preview, or the existing one is a non-previewable
 *   placeholder (a real message always wins), or
 * - the candidate is strictly newer, or
 * - the candidate is the SAME message with its encrypted fallback resolved
 *   (deferred-decrypt heal — same id and timestamp, so the newer-only rule
 *   alone would refuse it).
 *
 * Historically each of the four call sites hand-rolled this and drifted: room
 * merges replaced the preview unconditionally, so loading a deep-history
 * slice regressed the sidebar to an old message.
 */

import type { PreviewableMessage, MessageWithTimestamp, ResolvablePreview } from './lastMessageUtils'
import { shouldReplaceLastMessage, isResolvedSamePreview } from './lastMessageUtils'

export interface PreviewUpdate<T> {
  /** The preview to store: the candidate when it supersedes, else the existing one. */
  lastMessage: T | undefined
  /** True when the preview genuinely changed (callers can skip map writes otherwise). */
  changed: boolean
}

export function derivePreviewAfterMerge<
  T extends PreviewableMessage & MessageWithTimestamp & ResolvablePreview,
>(
  existing: T | undefined,
  merged: T[],
  pickCandidate: (messages: T[]) => T | undefined
): PreviewUpdate<T> {
  const candidate = merged.length > 0 ? pickCandidate(merged) : undefined
  const changed = !!(
    candidate &&
    (shouldReplaceLastMessage(existing, candidate) || isResolvedSamePreview(existing, candidate))
  )
  return { lastMessage: changed ? candidate : existing, changed }
}
