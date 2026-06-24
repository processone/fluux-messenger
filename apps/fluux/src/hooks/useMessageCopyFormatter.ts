/**
 * useMessageCopyFormatter - Formats copied message content with proper date headers.
 *
 * When copying across multiple messages, this hook ensures:
 * 1. A date header is always included at the top
 * 2. Messages are formatted consistently: "Nick HH:MM\nMessage"
 *
 * Two collection paths feed the same pure formatter (`buildCopyText`):
 *  - DOM path (default / non-virtualized): read each mounted row's `data-message-*`
 *    attributes for the rows the selection intersects.
 *  - Store-backed path (virtualized callers pass `messages` + `formatForCopy`):
 *    reconstruct the selected range from the in-memory array. This is needed because
 *    the virtualized DOM flattens date separators into separate windowed items, so the
 *    pure-DOM date walk below can't find them; sourcing from the array keeps the
 *    dates/names faithful.
 *
 * NOTE (verified on Blink, DOM-spec, same on WebKit): a selection can only ever be
 * WITHIN the mounted window. Virtualized rows are removed from the DOM as they scroll
 * out, and removing a node relocates any live Range boundary to the parent — so the
 * browser COLLAPSES a selection the instant it would span an unmounted row. There is
 * therefore no "spanning unmounted rows" case to recover; copying across rows that are
 * far off-screen is not achievable with DOM virtualization (a known limitation vs the
 * old full-mount behavior).
 */

import { useEffect, useRef, useState } from 'react'
import { buildCopyText, type CopyMessageMeta } from '@/utils/buildCopyText'

interface UseMessageCopyFormatterOptions<T extends { id: string }> {
  /** Callback ref setter - returns the element when set */
  containerRef: React.RefObject<HTMLElement | null>
  /** Locale for date formatting */
  locale?: string
  /**
   * In-memory ordered message array. Supplying this (with `formatForCopy`) enables
   * store-backed reconstruction for selections that span unmounted virtualized rows.
   * Omit on the non-virtualized path to keep the pure-DOM behavior unchanged.
   */
  messages?: T[]
  /** Maps a message to its copy metadata, faithful to the rendered bubble (the caller
   *  resolves the display name / time the same way it builds the row). */
  formatForCopy?: (message: T) => CopyMessageMeta
}

/** Resolve the message-row id a selection boundary falls within. The boundary is always
 *  on a mounted row (a selection can't span unmounted virtualized rows — the browser
 *  collapses it; see the file header), so `closest()` finds the `data-message-id`. */
function rowIdAtBoundary(node: Node): string | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null)
  return el?.closest?.('[data-message-id]')?.getAttribute('data-message-id') ?? null
}

/** Collect copy metadata from the mounted rows the selection intersects (DOM path). */
function collectDomSelection(container: HTMLElement, range: Range): CopyMessageMeta[] {
  // Only the actual MessageBubble carries data-message-from (not the wrapper div).
  const elements = container.querySelectorAll('[data-message-from]')
  const meta: CopyMessageMeta[] = []
  const seen = new Set<string>()

  elements.forEach((el) => {
    if (!range.intersectsNode(el)) return
    const id = el.getAttribute('data-message-id') || ''
    if (seen.has(id)) return
    seen.add(id)

    const from = el.getAttribute('data-message-from') || ''
    const time = el.getAttribute('data-message-time') || ''
    const body = el.getAttribute('data-message-body') || ''

    // Date from the parent group's date separator.
    // Structure: <div group> > <div data-date-separator> + <div wrapper> > <bubble>
    let groupDiv = el.parentElement?.parentElement
    let dateEl = groupDiv?.querySelector('[data-date-separator]')
    if (!dateEl && groupDiv?.parentElement) {
      groupDiv = groupDiv.parentElement
      dateEl = groupDiv?.querySelector('[data-date-separator]')
    }
    const date = dateEl?.getAttribute('data-date-separator') || ''

    meta.push({ id, from, time, body, date })
  })
  return meta
}

/**
 * Formats the selected content when copying from the message list.
 * Ensures date context is always present at the top.
 */
export function useMessageCopyFormatter<T extends { id: string } = { id: string }>({
  containerRef,
  locale = 'en',
  messages,
  formatForCopy,
}: UseMessageCopyFormatterOptions<T>): void {
  // Track container element in state to trigger effect when ref is set
  const [container, setContainer] = useState<HTMLElement | null>(null)

  // Latest-refs so the copy listener reads current data WITHOUT re-binding on every
  // new message (re-subscribing the listener per message would be wasteful churn).
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const formatForCopyRef = useRef(formatForCopy)
  formatForCopyRef.current = formatForCopy

  // Sync ref to state (check on every render)
  useEffect(() => {
    if (containerRef.current !== container) {
      setContainer(containerRef.current)
    }
  }, [containerRef, container])

  useEffect(() => {
    if (!container) return

    const handleCopy = (e: ClipboardEvent) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return

      // Check if selection is within our container
      const range = selection.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) return

      // Check if selection is entirely within a single message bubble.
      // If so, let the browser's default copy behavior handle it (partial text).
      const startMessage = range.startContainer.parentElement?.closest('[data-message-id]')
      const endMessage = range.endContainer.parentElement?.closest('[data-message-id]')
      if (startMessage && endMessage && startMessage === endMessage) {
        return
      }

      const setClipboard = (text: string | null) => {
        if (text == null) return
        e.preventDefault()
        e.clipboardData?.setData('text/plain', text)
      }

      // Store-backed path (virtualized): reconstruct the selected range from the
      // in-memory array (the source of truth for ordering AND dates/names), because the
      // virtualized DOM lacks the date separators the DOM path reads. Endpoints are
      // always mounted (a selection can't span unmounted rows — see the file header).
      const msgs = messagesRef.current
      const format = formatForCopyRef.current
      if (msgs && format) {
        const startId = rowIdAtBoundary(range.startContainer)
        const endId = rowIdAtBoundary(range.endContainer)
        if (startId && endId && startId !== endId) {
          const i0 = msgs.findIndex((m) => m.id === startId)
          const i1 = msgs.findIndex((m) => m.id === endId)
          if (i0 !== -1 && i1 !== -1) {
            const lo = Math.min(i0, i1)
            const hi = Math.max(i0, i1)
            setClipboard(buildCopyText(msgs.slice(lo, hi + 1).map(format)))
            return
          }
        }
        // Endpoints unresolved → fall through to the DOM path (best effort).
      }

      // DOM path: collect metadata from the mounted rows the selection intersects.
      setClipboard(buildCopyText(collectDomSelection(container, range)))
    }

    container.addEventListener('copy', handleCopy)
    return () => container.removeEventListener('copy', handleCopy)
  }, [container, locale])
}
