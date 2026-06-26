/**
 * messageRangeSelection — pure core for virtualization-friendly bulk copy.
 *
 * A "copy range" is a contiguous span over the in-memory message array, identified by an
 * anchor id and a focus id. It is decoupled from the browser's text selection (which cannot
 * span virtualized/unmounted rows). All functions here are pure (no DOM, no React) so the
 * range logic is unit-tested in isolation; the hook layers state + listeners + clipboard on
 * top, and buildCopyText turns the collected metadata into text.
 */
import type { CopyMessageMeta } from './buildCopyText'

export interface CopyRange {
  anchorId: string
  focusId: string
}

export type SelectionAction =
  | { type: 'extendTo'; id: string }
  | { type: 'selectAll' }
  | { type: 'clear' }

/** Indices of the range endpoints in array order, direction-agnostic. null when either id
 *  is absent (e.g. a selected message was retracted). */
export function rangeIndices(
  orderedIds: string[],
  range: CopyRange,
): { start: number; end: number } | null {
  const a = orderedIds.indexOf(range.anchorId)
  const f = orderedIds.indexOf(range.focusId)
  if (a === -1 || f === -1) return null
  return { start: Math.min(a, f), end: Math.max(a, f) }
}

/** The inclusive slice of ids in array order (empty when the range is invalid). */
export function rangeIds(orderedIds: string[], range: CopyRange): string[] {
  const idx = rangeIndices(orderedIds, range)
  if (!idx) return []
  return orderedIds.slice(idx.start, idx.end + 1)
}

/** Whole-list range, or null when the list is empty. */
export function selectAllRange(orderedIds: string[]): CopyRange | null {
  if (orderedIds.length === 0) return null
  return { anchorId: orderedIds[0], focusId: orderedIds[orderedIds.length - 1] }
}

/** Drop the selection if an endpoint vanished (retraction, conversation switch). */
export function pruneRange(range: CopyRange | null, orderedIds: string[]): CopyRange | null {
  if (!range) return null
  if (orderedIds.indexOf(range.anchorId) === -1 || orderedIds.indexOf(range.focusId) === -1) {
    return null
  }
  return range
}

/** Pure state transition. extendTo begins the range when state is null, otherwise keeps the
 *  anchor and moves the focus; an unknown id is ignored. */
export function selectionReducer(
  state: CopyRange | null,
  action: SelectionAction,
  orderedIds: string[],
): CopyRange | null {
  switch (action.type) {
    case 'clear':
      return null
    case 'selectAll':
      return selectAllRange(orderedIds)
    case 'extendTo':
      if (orderedIds.indexOf(action.id) === -1) return state
      if (!state) return { anchorId: action.id, focusId: action.id }
      return { anchorId: state.anchorId, focusId: action.id }
  }
}

/** Slice messages to the range and map each to clipboard metadata, ready for buildCopyText.
 *  Pure given a pure formatForCopy. */
export function collectRangeMeta<T extends { id: string }>(
  messages: T[],
  range: CopyRange,
  formatForCopy: (m: T) => CopyMessageMeta,
): CopyMessageMeta[] {
  const idx = rangeIndices(
    messages.map((m) => m.id),
    range,
  )
  if (!idx) return []
  return messages.slice(idx.start, idx.end + 1).map(formatForCopy)
}
