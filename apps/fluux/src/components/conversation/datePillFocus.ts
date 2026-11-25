const findCoverageUpdates = new WeakMap<HTMLElement, () => void>()

/** A date opener must still be visible, including inside the clipped timeline. */
export function isDatePillVisible(opener: HTMLElement | null): opener is HTMLElement {
  if (!opener?.isConnected || opener.closest('[inert], [aria-hidden="true"]')) return false
  const style = getComputedStyle(opener)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = opener.getBoundingClientRect()
  const list = opener.closest('[data-message-list]')?.getBoundingClientRect()
  const top = Math.max(0, list?.top ?? 0)
  const bottom = Math.min(window.innerHeight, list?.bottom ?? window.innerHeight)
  // Cancellation can restore focus before the coverage observer sees a layout change.
  return rect.width > 0 && rect.height > 0 && rect.bottom > top && rect.top < bottom &&
    rect.right > 0 && rect.left < window.innerWidth && !isDatePillCoveredByFind(opener)
}

/** The existing conversation menu remains reachable when a date pill disappears. */
export function focusConversationActions(from: HTMLElement | null) {
  const root = from?.closest('[data-conversation-thread]')
  if (root?.closest('[inert], [aria-hidden="true"]')) return
  root?.querySelector<HTMLElement>('[data-header-overflow-trigger]')?.focus({ preventScroll: true })
}

export function refreshDatePillsCoveredByFind(from: HTMLElement | null) {
  const root = from?.closest<HTMLElement>('[data-conversation-thread]')
  if (root) findCoverageUpdates.get(root)?.()
}

export function isDatePillCoveredByFind(pill: HTMLElement, find = pill.closest('[data-conversation-thread]')?.querySelector<HTMLElement>('[data-find-on-page-bar]')) {
  if (!find || !pill.matches('[data-date-pill]')) return false
  const rect = pill.getBoundingClientRect()
  const cover = find.getBoundingClientRect()
  const list = pill.closest('[data-message-list]')?.getBoundingClientRect()
  const left = Math.max(0, rect.left, list?.left ?? 0)
  const right = Math.min(window.innerWidth, rect.right, list?.right ?? window.innerWidth)
  const top = Math.max(0, rect.top, list?.top ?? 0)
  const bottom = Math.min(window.innerHeight, rect.bottom, list?.bottom ?? window.innerHeight)
  return right > left && bottom > top && cover.left <= left && cover.right >= right && cover.top <= top && cover.bottom >= bottom
}

export function observeDatePillsCoveredByFind(root: HTMLElement) {
  const find = root.querySelector<HTMLElement>('[data-find-on-page-bar]')
  if (!find) return
  const pills = new Set<HTMLElement>()
  const setCovered = (pill: HTMLElement, covered: boolean) => {
    pill.toggleAttribute('data-find-covered', covered)
    // The floating wrapper's inert state belongs to the live-edge and unread controls.
    pill.toggleAttribute('inert', covered)
    if (covered) pill.setAttribute('aria-hidden', 'true')
    else pill.removeAttribute('aria-hidden')
  }
  const update = () => {
    const current = new Set(root.querySelectorAll<HTMLElement>('[data-date-pill]'))
    for (const pill of pills) {
      if (!current.has(pill)) { resize.unobserve(pill); pills.delete(pill) }
    }
    for (const pill of current) {
      if (!pills.has(pill)) { pills.add(pill); resize.observe(pill) }
      const covered = isDatePillCoveredByFind(pill, find)
      if (covered === pill.hasAttribute('data-find-covered')) continue
      const heldFocus = document.activeElement === pill
      setCovered(pill, covered)
      if (covered && heldFocus) focusConversationActions(root)
    }
  }
  const resize = new ResizeObserver(update)
  const mutations = new MutationObserver(update)
  findCoverageUpdates.set(root, update)
  resize.observe(root)
  resize.observe(find)
  mutations.observe(root, { childList: true, subtree: true })
  root.addEventListener('scroll', update, true)
  update()
  return () => {
    findCoverageUpdates.delete(root)
    resize.disconnect()
    mutations.disconnect()
    root.removeEventListener('scroll', update, true)
    for (const pill of pills) setCovered(pill, false)
  }
}
