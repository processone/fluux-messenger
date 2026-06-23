/**
 * Scroll-position math for the message list. Pure (no DOM) so it is unit-testable and
 * tunable without a live build. All inputs are pixels; offsets MUST come from MEASURED
 * row positions (never estimated) to avoid micro-jumps.
 *
 * See docs/superpowers/specs/2026-06-23-message-view-virtualization-design.md
 */

/** scrollTop that puts the anchor message's bottom `bottomGap` px above the viewport bottom. */
export function anchorBottomScrollTop(offset: number, size: number, bottomGap: number, clientHeight: number): number {
  return offset + size + bottomGap - clientHeight
}

/** scrollTop that shows the target ~1/3 down from the viewport top, clamped at 0. */
export function markerScrollTop(offset: number, clientHeight: number): number {
  return Math.max(0, offset - clientHeight / 3)
}

/** scrollTop that keeps a prepend anchor at the same offset-from-top it had before the prepend. */
export function prependAnchorScrollTop(newOffset: number, savedOffsetFromTop: number): number {
  return newOffset - savedOffsetFromTop
}
