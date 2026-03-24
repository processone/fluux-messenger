import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { scrollToMessage } from '@/components/conversation/messageGrouping'

interface MessageLike {
  id: string
  body?: string
}

export interface FindOnPageState {
  /** Whether the find bar is visible */
  isOpen: boolean
  /** Current search text */
  searchText: string
  /** IDs of messages that match, ordered newest-first */
  matchIds: string[]
  /** Current match index (0-based into matchIds) */
  currentMatchIndex: number
  /** Terms to highlight in message bodies */
  highlightTerms: string[]
  /** Open the find bar */
  open: () => void
  /** Close the find bar and clear state */
  close: () => void
  /** Set the search text */
  setSearchText: (text: string) => void
  /** Go to the next match (older message) */
  goToNext: () => void
  /** Go to the previous match (newer message) */
  goToPrev: () => void
}

/**
 * Hook for browser-style "find on page" within a conversation's messages.
 *
 * Matches are ordered newest-first (bottom of conversation first).
 * "Next" moves to older messages, "Prev" moves to newer messages.
 */
export function useFindOnPage<T extends MessageLike>(messages: T[]): FindOnPageState {
  const [isOpen, setIsOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const currentMatchIndexRef = useRef(0)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  // Keep ref in sync
  currentMatchIndexRef.current = currentMatchIndex

  // Compute matching message IDs (newest-first = reversed from messages array order)
  const matchIds = useMemo(() => {
    const trimmed = searchText.trim().toLowerCase()
    if (!trimmed || trimmed.length < 2) return []

    const ids: string[] = []
    // Messages array is oldest-first, we want newest-first
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.body && msg.body.toLowerCase().includes(trimmed)) {
        ids.push(msg.id)
      }
    }
    return ids
  }, [messages, searchText])

  // Derive highlight terms from search text
  const highlightTerms = useMemo(() => {
    const trimmed = searchText.trim()
    if (!trimmed || trimmed.length < 2) return []
    return [trimmed.toLowerCase()]
  }, [searchText])

  // Reset current match index when matches change, and scroll to first match
  useEffect(() => {
    setCurrentMatchIndex(0)
    if (matchIds.length > 0) {
      scrollToMessage(matchIds[0])
    }
  }, [matchIds])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setSearchText('')
    setCurrentMatchIndex(0)
  }, [])

  const goToNext = useCallback(() => {
    if (matchIds.length === 0) return
    const next = (currentMatchIndexRef.current + 1) % matchIds.length
    setCurrentMatchIndex(next)
    scrollToMessage(matchIds[next])
  }, [matchIds])

  const goToPrev = useCallback(() => {
    if (matchIds.length === 0) return
    const prev = (currentMatchIndexRef.current - 1 + matchIds.length) % matchIds.length
    setCurrentMatchIndex(prev)
    scrollToMessage(matchIds[prev])
  }, [matchIds])

  return {
    isOpen,
    searchText,
    matchIds,
    currentMatchIndex,
    highlightTerms,
    open,
    close,
    setSearchText,
    goToNext,
    goToPrev,
  }
}
