/**
 * useMessageCopyFormatter - Formats copied message content with proper date headers.
 *
 * When copying messages from the chat, this hook ensures:
 * 1. A date header is always included at the top
 * 2. Messages are formatted consistently: "Nick HH:MM\nMessage"
 */

import { useEffect, useState } from 'react'
import { format, parseISO } from 'date-fns'

interface UseMessageCopyFormatterOptions {
  /** Callback ref setter - returns the element when set */
  containerRef: React.RefObject<HTMLElement | null>
  /** Locale for date formatting */
  locale?: string
}

/**
 * Formats the selected content when copying from the message list.
 * Ensures date context is always present at the top.
 */
export function useMessageCopyFormatter({
  containerRef,
  locale = 'en',
}: UseMessageCopyFormatterOptions): void {
  // Track container element in state to trigger effect when ref is set
  const [container, setContainer] = useState<HTMLElement | null>(null)

  // Sync ref to state (check on every render)
  useEffect(() => {
    if (containerRef.current !== container) {
      setContainer(containerRef.current)
    }
  })

  useEffect(() => {
    if (!container) return

    const handleCopy = (e: ClipboardEvent) => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) return

      // Check if selection is within our container
      const range = selection.getRangeAt(0)
      if (!container.contains(range.commonAncestorContainer)) return

      // Get all selected message elements - only get the ones with data-message-from
      // (the actual MessageBubble, not the wrapper div)
      const messageElements = container.querySelectorAll('[data-message-from]')
      const selectedMessages: Array<{
        id: string
        from: string
        time: string
        body: string
        date: string
      }> = []

      let earliestDate: string | null = null
      const seenIds = new Set<string>()

      messageElements.forEach((el) => {
        if (range.intersectsNode(el)) {
          const id = el.getAttribute('data-message-id') || ''

          // Skip duplicates
          if (seenIds.has(id)) return
          seenIds.add(id)

          const from = el.getAttribute('data-message-from') || ''
          const time = el.getAttribute('data-message-time') || ''
          const body = el.getAttribute('data-message-body') || ''

          // Find the date from the parent group's date separator
          // Structure: <div group> > <div data-date-separator> + <div wrapper> > <div MessageBubble>
          // Walk up to find the group container, then find the date separator
          let groupDiv = el.parentElement?.parentElement
          let dateEl = groupDiv?.querySelector('[data-date-separator]')

          // If not found, try one level up
          if (!dateEl && groupDiv?.parentElement) {
            groupDiv = groupDiv.parentElement
            dateEl = groupDiv?.querySelector('[data-date-separator]')
          }

          const date = dateEl?.getAttribute('data-date-separator') || ''

          // Track earliest date found (for fallback when some messages don't have dates)
          if (date && date.length > 0 && (!earliestDate || date < earliestDate)) {
            earliestDate = date
          }

          if (body) {
            selectedMessages.push({ id, from, time, body, date })
          }
        }
      })

      // If we have selected messages, format the output
      if (selectedMessages.length > 0) {
        // Use today's date as fallback if no date separator was found
        const fallbackDate = earliestDate || format(new Date(), 'yyyy-MM-dd')

        // Group by date for proper formatting
        const messagesByDate = new Map<string, typeof selectedMessages>()

        selectedMessages.forEach((msg) => {
          const dateKey = msg.date || fallbackDate
          if (!messagesByDate.has(dateKey)) {
            messagesByDate.set(dateKey, [])
          }
          messagesByDate.get(dateKey)!.push(msg)
        })

        // Build formatted output
        const lines: string[] = []

        // Sort dates chronologically
        const sortedDates = [...messagesByDate.keys()].sort()

        sortedDates.forEach((dateStr, dateIndex) => {
          // Add date header
          try {
            const date = parseISO(dateStr)
            const formattedDate = format(date, 'EEEE, MMMM d, yyyy')
            if (dateIndex > 0) lines.push('') // Empty line between date groups
            lines.push(`— ${formattedDate} —`)
          } catch {
            lines.push(`— ${dateStr} —`)
          }

          // Add messages for this date
          const msgs = messagesByDate.get(dateStr)!
          msgs.forEach((msg) => {
            if (msg.from && msg.time) {
              lines.push(`${msg.from} ${msg.time}`)
            }
            lines.push(msg.body)
          })
        })

        // Set the formatted text to clipboard
        const output = lines.join('\n')
        e.preventDefault()
        e.clipboardData?.setData('text/plain', output)
      }
    }

    container.addEventListener('copy', handleCopy)
    return () => container.removeEventListener('copy', handleCopy)
  }, [container, locale])
}
