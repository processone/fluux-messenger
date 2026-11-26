import { messageRowId, messageRowRefFromRowId } from '@/components/conversation/messageRowIdentity'
import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import { scrollToMessage } from '@/components/conversation/messageGrouping'

interface MessageLike {
  id: string
  body?: string
}

const defaultRowId = <T extends MessageLike>(message: T): string => messageRowId(message)!

/** Handle exposed to parent components via ref for keyboard shortcut integration */
export interface FindOnPageHandle {
  open: () => void
  close: () => void
  isOpen: boolean
  goToNext: () => void
  goToPrev: () => void
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
export function useFindOnPage<T extends MessageLike>(
  messages: T[],
  conversationId?: string,
  getRowId: (message: T) => string | undefined = defaultRowId,
): FindOnPageState {
  const [isOpen, setIsOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const currentMatchIndexRef = useRef(0)
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0)

  // Keep ref in sync
  currentMatchIndexRef.current = currentMatchIndex

  const matchIds = useMemo(() => {
    const trimmed = searchText.trim().toLowerCase()
    if (!trimmed || trimmed.length < 2) return []

    const found: string[] = []
    for (const msg of messages) {
      if (msg.body && msg.body.toLowerCase().includes(trimmed)) {
        found.push(getRowId(msg) ?? msg.id)
      }
    }
    return found
  }, [getRowId, messages, searchText])

  // Derive highlight terms from search text
  const highlightTerms = useMemo(() => {
    const trimmed = searchText.trim()
    if (!trimmed || trimmed.length < 2) return []
    return [trimmed.toLowerCase()]
  }, [searchText])

  // The index resets during render because an effect runs after the commit, which
  // would show the previous index against the new matches (1/19, or even 3/2).
  // Keyed on the search text, not matchIds, so arriving messages keep the position.
  const query = searchText.trim().toLowerCase()
  const [indexedQuery, setIndexedQuery] = useState('')
  if (query !== indexedQuery) {
    setIndexedQuery(query)
    setCurrentMatchIndex(Math.max(matchIds.length - 1, 0))
  }

  // Scroll to the newest match once per search text.
  const prevSearchTextRef = useRef('')
  useEffect(() => {
    const trimmed = searchText.trim().toLowerCase()
    if (trimmed === prevSearchTextRef.current) return
    prevSearchTextRef.current = trimmed

    if (matchIds.length > 0) {
      scrollToMessage(messageRowRefFromRowId(matchIds[matchIds.length - 1]))
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
    scrollToMessage(messageRowRefFromRowId(matchIds[next]))
  }, [matchIds])

  const goToPrev = useCallback(() => {
    if (matchIds.length === 0) return
    const prev = (currentMatchIndexRef.current - 1 + matchIds.length) % matchIds.length
    setCurrentMatchIndex(prev)
    scrollToMessage(messageRowRefFromRowId(matchIds[prev]))
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
