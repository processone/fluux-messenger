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
  /** IDs of messages that match, ordered oldest-first (document order) */
  matchIds: string[]
  /** Current match index (0-based into matchIds) */
  currentMatchIndex: number
  /** Terms to highlight in message bodies */
  highlightTerms: string[]
  /** ID of the message currently focused by find navigation */
  currentMatchId: string | undefined
  /** Open the find bar */
  open: () => void
  /** Close the find bar and clear state */
  close: () => void
  /** Set the search text */
  setSearchText: (text: string) => void
  /** Go to the next match (downward / newer message) */
  goToNext: () => void
  /** Go to the previous match (upward / older message) */
  goToPrev: () => void
}

/**
 * Hook for browser-style "find on page" within a conversation's messages.
 *
 * Matches are ordered oldest-first (document order, top of conversation first).
 * "Next" moves downward (newer), "Prev" moves upward (older).
 * Initial match starts at the bottom (newest match).
 */
export function useFindOnPage<T extends MessageLike>(messages: T[], conversationId?: string): FindOnPageState {
  const [isOpen, setIsOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const currentMatchIndexRef = useRef(0)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  // Keep ref in sync
  currentMatchIndexRef.current = currentMatchIndex

  // Compute matching message IDs in oldest-first order (same as messages array)
  const matchIds = useMemo(() => {
    const trimmed = searchText.trim().toLowerCase()
    if (!trimmed || trimmed.length < 2) return []

    const ids: string[] = []
    for (const msg of messages) {
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

  // Reset current match index and scroll to newest match when search text changes.
  // We track searchText (not matchIds) to avoid resetting position when new messages arrive.
  const prevSearchTextRef = useRef('')
  useEffect(() => {
    const trimmed = searchText.trim().toLowerCase()
    if (trimmed === prevSearchTextRef.current) return
    prevSearchTextRef.current = trimmed

    const startIndex = matchIds.length > 0 ? matchIds.length - 1 : 0
    setCurrentMatchIndex(startIndex)
    if (matchIds.length > 0) {
      scrollToMessage(matchIds[startIndex])
    }
  }, [matchIds, searchText])

  const open = useCallback(() => {
    setIsOpen(true)
  }, [])

  const close = useCallback(() => {
    setIsOpen(false)
    setSearchText('')
    setCurrentMatchIndex(0)
  }, [])

  // Dismiss find bar when the conversation changes
  const prevConversationIdRef = useRef(conversationId)
  useEffect(() => {
    if (prevConversationIdRef.current !== conversationId) {
      prevConversationIdRef.current = conversationId
      close()
    }
  }, [conversationId, close])

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
    currentMatchId: matchIds[currentMatchIndex],
    highlightTerms,
    open,
    close,
    setSearchText,
    goToNext,
    goToPrev,
  }
}
