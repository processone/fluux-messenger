/**
 * Copy-on-write edits to the per-entity maps both stores keep.
 *
 * `chatStore` and `roomStore` hold the same four maps under different names —
 * new-message markers, archive coverage, forward-gap intervals, and the
 * entity/metadata pair a preview timestamp is read from. The edits here were
 * written twice, once per store, and had already drifted in shape if not yet in
 * behaviour.
 *
 * Every function returns `null` when nothing changed, and a fresh map
 * otherwise. That is what keeps them usable from both stores despite their
 * different persistence: a Zustand `set` returning the same reference skips the
 * re-render, and the caller — not this module — decides whether a change also
 * has to reach disk. `roomStore` persists these maps by hand; `chatStore` rides
 * its `persist` middleware.
 *
 * These are deliberately the edits that touch ONE map. The methods that patch
 * an entity across several maps are not here: the two stores project their
 * entities differently (`Conversation` is entity + metadata, `Room` is entity +
 * metadata + runtime), so a shared writer for those would have to encode both
 * models before it encoded any behaviour.
 *
 * @packageDocumentation
 * @module Stores/Shared
 */

import type { CoverageRecord } from '../../core/types'
import type { GapInterval } from './mamGap'

/**
 * Drop one entity's new-message marker.
 *
 * @returns the new map, or `null` when the entity had no marker.
 */
export function clearMarker<T>(markers: Map<string, T>, key: string): Map<string, T> | null {
  if (!markers.has(key)) return null
  const next = new Map(markers)
  next.delete(key)
  return next
}

/**
 * The timestamp of an entity's last message, in epoch ms.
 *
 * Reads the metadata map first — it is the one kept current — and falls back to
 * the combined compat map, which persisted state and older tests still populate
 * on its own.
 */
export function lastMessageTimestamp(
  meta: Map<string, { lastMessage?: { timestamp?: Date } } | undefined>,
  compat: Map<string, { lastMessage?: { timestamp?: Date } } | undefined>,
  key: string
): number | undefined {
  const lastMessage = meta.get(key)?.lastMessage ?? compat.get(key)?.lastMessage
  return lastMessage?.timestamp?.getTime()
}

/**
 * Drop an entity's contiguous-with-live coverage record.
 *
 * `ifBottomId` makes the removal conditional: a caller that observed a purged
 * anchor passes the id it saw, so a record another path has since replaced is
 * left alone rather than deleted on stale evidence.
 *
 * @returns the new map, or `null` when there was no record or the guard failed.
 */
export function clearCoverageEntry(
  coverage: Map<string, CoverageRecord>,
  key: string,
  ifBottomId?: string
): Map<string, CoverageRecord> | null {
  const existing = coverage.get(key)
  if (!existing) return null
  if (ifBottomId !== undefined && existing.bottomId !== ifBottomId) return null
  const next = new Map(coverage)
  next.delete(key)
  return next
}

/**
 * Drop a forward gap's resume anchor while keeping the gap itself.
 *
 * The anchor is an archive id the server has since purged (`item-not-found`);
 * the hole it marks is still real, so the interval stays and only the cursor
 * goes. Guarded on `purgedStartId` for the same reason as coverage: another
 * path may have re-anchored the gap in the meantime.
 *
 * @returns the new map, or `null` when there is no such gap or the anchor moved.
 */
export function clearGapAnchor(
  gaps: Map<string, GapInterval>,
  key: string,
  purgedStartId: string
): Map<string, GapInterval> | null {
  const gap = gaps.get(key)
  if (!gap || gap.startId !== purgedStartId) return null
  const next = new Map(gaps)
  const { startId: _purged, ...withoutAnchor } = gap
  next.set(key, withoutAnchor)
  return next
}
