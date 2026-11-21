import { findMessageRowIndex, type MessageRowRef } from '../../utils/messageIdentity'

/**
 * A load-around read is bounded to one resident window of newer rows, because
 * the resident window cannot hold more than that anyway. These helpers keep the
 * result identical to an unbounded read when the cache tail is longer than that
 * bound: the window is reported as off the live edge, and the resident newest
 * messages — which would sit past a gap after the bounded slice — are dropped
 * just as the window trim would have evicted them.
 */

/** Number of rows in `slice` strictly after the anchor row (0 when the anchor is absent). */
export function rowsAfterAnchor<T>(slice: readonly T[], anchorRow: MessageRowRef): number {
  const index = findMessageRowIndex(slice as never, anchorRow)
  return index < 0 ? 0 : slice.length - index - 1
}

/** Resident messages with the ones newer than the bounded slice's last row removed, when the tail was truncated. */
export function withoutRowsPastSlice<T extends { timestamp: Date }>(
  resident: T[],
  slice: readonly T[],
  tailTruncated: boolean,
): T[] {
  if (!tailTruncated || slice.length === 0) return resident
  const lastSliceTime = slice[slice.length - 1].timestamp.getTime()
  return resident.filter(message => message.timestamp.getTime() <= lastSliceTime)
}
