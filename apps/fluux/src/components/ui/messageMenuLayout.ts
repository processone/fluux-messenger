interface Box { left: number; top: number; width: number; height: number }

/** Keep the preview over its source until the surrounding controls require a shift. */
export function messageMenuLayout(
  anchor: Box,
  viewport: Box,
  reactionsHeight: number,
  actionsHeight: number,
  previewHeight: number,
  menuWidth: number,
) {
  const gapBefore = reactionsHeight > 0 ? 8 : 0
  const gaps = gapBefore + 8
  const previewWidth = Math.min(anchor.width, viewport.width)
  const width = Math.min(Math.max(previewWidth, menuWidth), viewport.width)
  const x = Math.max(viewport.left, Math.min(anchor.left, viewport.left + viewport.width - width))
  const previewOffset = Math.max(0, Math.min(anchor.left - x, width - previewWidth))
  // On short screens keep some message context and let the actions scroll.
  const actionsMaxHeight = Math.max(0, viewport.height - reactionsHeight - gaps - Math.min(previewHeight, 64))
  const visibleActionsHeight = Math.min(actionsHeight, actionsMaxHeight)
  const previewMaxHeight = Math.max(0, viewport.height - reactionsHeight - gaps - visibleActionsHeight)
  const height = reactionsHeight + gaps + Math.min(previewHeight, previewMaxHeight) + visibleActionsHeight
  const preferredY = anchor.top - reactionsHeight - gapBefore
  const y = Math.max(viewport.top, Math.min(preferredY, viewport.top + viewport.height - height))
  return { x, y, width, previewWidth, previewOffset, previewMaxHeight, actionsMaxHeight }
}
