import { expect } from '@playwright/test'

/** One frame's reading of the message list during a native pan: its offset, its extent and the
 * first message fully inside the view, with its virtual index as `order`. */
export type PanSample = {
  at: number; top: number; height: number; client: number
  anchor: { id: string; order: number; top: number; bottom: number } | null
}

/** During an upward pan a later reading cannot show a newer message first, and the same message
 * cannot move up the view. */
export function expectProgress(before: PanSample, after: PanSample, context: string) {
  expect(before.anchor, `${context}: an initial visible message anchors the comparison`).not.toBeNull()
  expect(after.anchor, `${context}: a final visible message anchors the comparison`).not.toBeNull()
  expect(after.anchor!.order, `${context}: cannot return to a newer message`).toBeLessThanOrEqual(before.anchor!.order)
  if (after.anchor!.id === before.anchor!.id) expect(after.anchor!.top, `${context}: the same message cannot move against the pan`).toBeGreaterThanOrEqual(before.anchor!.top - 1)
}

/** Native autoscroll moves by elapsed time, so after a stalled frame it legitimately reveals much
 * more; only readings this close together are compared for continuity. A slow runner spaces its
 * frames about 100ms apart, and the refresh frame itself takes longer. */
export const FRAME_GAP_MS = 250

/** An upward pan brings at most a few rows above the previous first message into view per 100ms of
 * native movement; a reading that lands further back has skipped what the reader had not reached. */
export function expectContinuity(before: PanSample, after: PanSample, context: string, rows = 3) {
  const elapsed = after.at - before.at
  if (elapsed > FRAME_GAP_MS) return
  const allowed = Math.max(rows, Math.ceil(rows * elapsed / 100))
  expect(before.anchor!.order - after.anchor!.order, `${context}: cannot skip older messages`).toBeLessThanOrEqual(allowed)
}
