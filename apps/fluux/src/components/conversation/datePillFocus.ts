/** A date opener must still be visible, including inside the clipped timeline. */
export function isDatePillVisible(opener: HTMLElement | null): opener is HTMLElement {
  if (!opener?.isConnected || opener.closest('[inert], [aria-hidden="true"]')) return false
  const style = getComputedStyle(opener)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = opener.getBoundingClientRect()
  const list = opener.closest('[data-message-list]')?.getBoundingClientRect()
  const top = Math.max(0, list?.top ?? 0)
  const bottom = Math.min(window.innerHeight, list?.bottom ?? window.innerHeight)
  return rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom &&
    rect.right > 0 && rect.left < window.innerWidth
}

/** The existing conversation menu remains reachable when a date pill disappears. */
export function focusConversationActions(from: HTMLElement | null) {
  const root = from?.closest('[data-conversation-thread]')
  if (root?.closest('[inert], [aria-hidden="true"]')) return
  root?.querySelector<HTMLElement>('[data-header-overflow-trigger]')?.focus({ preventScroll: true })
}
