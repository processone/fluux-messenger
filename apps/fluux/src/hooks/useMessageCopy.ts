import { useCallback, useEffect, type RefObject } from 'react'

interface MessageData {
  id: string
  from: string
  body: string
  timestamp: string
}

/**
 * Hook to handle formatted message copying.
 * Groups consecutive messages from the same sender and formats with headers.
 *
 * Example output:
 * Alice [14:30]:
 * Hello there
 * How are you?
 *
 * Bob [14:32]:
 * I'm good, thanks!
 */
export function useMessageCopy(containerRef: RefObject<HTMLElement | null>) {
  const handleCopy = useCallback((e: ClipboardEvent) => {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) return

    const container = containerRef.current
    if (!container) return

    // Check if selection is within our container
    const range = selection.getRangeAt(0)
    if (!container.contains(range.commonAncestorContainer)) return

    // Find all message elements that intersect with selection
    const messageElements = container.querySelectorAll('[data-message-id]')
    const selectedMessages: MessageData[] = []

    for (const element of messageElements) {
      // Check if this message element intersects with the selection
      if (selection.containsNode(element, true)) {
        const id = element.getAttribute('data-message-id') || ''
        const from = element.getAttribute('data-message-from') || ''
        const body = element.getAttribute('data-message-body') || ''
        const timestamp = element.getAttribute('data-message-time') || ''

        // Only include if we have body content
        if (body && from) {
          selectedMessages.push({ id, from, body, timestamp })
        }
      }
    }

    // If no messages found or only one message, let default copy behavior handle it
    if (selectedMessages.length <= 1) return

    // Group consecutive messages from the same sender
    const groups: { from: string; timestamp: string; messages: string[] }[] = []

    for (const msg of selectedMessages) {
      const lastGroup = groups[groups.length - 1]

      if (lastGroup && lastGroup.from === msg.from) {
        // Same sender, add to current group
        lastGroup.messages.push(msg.body)
      } else {
        // New sender, create new group
        groups.push({
          from: msg.from,
          timestamp: msg.timestamp,
          messages: [msg.body]
        })
      }
    }

    // Format the output
    const formattedText = groups.map(group => {
      const header = `${group.from} [${group.timestamp}]:`
      const body = group.messages.join('\n')
      return `${header}\n${body}`
    }).join('\n\n')

    // Set clipboard data
    e.preventDefault()
    e.clipboardData?.setData('text/plain', formattedText)
  }, [containerRef])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    container.addEventListener('copy', handleCopy)
    return () => container.removeEventListener('copy', handleCopy)
  }, [containerRef, handleCopy])
}
