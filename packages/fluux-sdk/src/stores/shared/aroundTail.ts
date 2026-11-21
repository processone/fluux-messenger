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

/**
 * Read a load-around slice bounded to one resident window of newer rows.
 *
 * The bound is only safe when the window trim really evicts the newest rows: the hidden-row
 * compaction inside the trim can leave a bounded slice shorter than the window, and then
 * the window would end inside the cache with its tail unread (and, at a tied timestamp,
 * a continuation by exclusive timestamp would skip rows). In that case the read is repeated
 * unbounded, which is the previous behaviour.
 *
 * @param read reads the slice; `after` undefined means no bound
 * @param evictsNewest whether the shared around-slice trim evicts the newest row for this bounded slice
 */
export async function readAroundBounded<T>(
  options: { after?: number },
  bound: number,
  anchorRow: MessageRowRef,
  read: (after: number | undefined) => Promise<T[]>,
  evictsNewest: (slice: T[]) => boolean,
): Promise<{ slice: T[]; tailTruncated: boolean }> {
  if (options.after !== undefined) return { slice: await read(options.after), tailTruncated: false }
  const slice = await read(bound)
  if (rowsAfterAnchor(slice, anchorRow) < bound) return { slice, tailTruncated: false }
  if (evictsNewest(slice)) return { slice, tailTruncated: true }
  return { slice: await read(undefined), tailTruncated: false }
}
