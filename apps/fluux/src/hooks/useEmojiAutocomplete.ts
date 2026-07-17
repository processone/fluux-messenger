import { useState, useEffect, useRef, useMemo } from 'react'

export interface EmojiMatch {
  id: string
  name: string
  native: string
}

export interface EmojiAutocompleteState {
  isActive: boolean
  query: string
  triggerIndex: number
  selectedIndex: number
  matches: EmojiMatch[]
}

/**
 * Hook for inline emoji autocomplete in the message composer.
 *
 * Detects `:` followed by characters and queries the @emoji-mart/data
 * emoji database to return matching suggestions.
 */
export function useEmojiAutocomplete(
  text: string,
  cursorPosition: number,
): {
  state: EmojiAutocompleteState
  selectMatch: (index: number) => { newText: string; newCursorPosition: number }
  moveSelection: (direction: 'up' | 'down') => void
  dismiss: () => void
} {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const dismissedAtTriggerRef = useRef<number>(-1)
  const currentTriggerRef = useRef<number>(-1)
  const [emojiData, setEmojiData] = useState<any>(null)

  // Detect : trigger and extract query
  const detectTrigger = (): { isActive: boolean; query: string; triggerIndex: number } => {
    if (dismissed) {
      return { isActive: false, query: '', triggerIndex: currentTriggerRef.current }
    }

    // Look for : before cursor
    const beforeCursor = text.slice(0, cursorPosition)

    // Find the last : that could be an emoji trigger
    // Must be at start or preceded by whitespace
    let colonIndex = -1
    for (let i = beforeCursor.length - 1; i >= 0; i--) {
      if (beforeCursor[i] === ':') {
        // Check if at start or preceded by whitespace
        if (i === 0 || /\s/.test(beforeCursor[i - 1])) {
          colonIndex = i
          break
        }
      }
      // Stop if we hit whitespace (emoji shortcode must not contain spaces)
      if (/\s/.test(beforeCursor[i])) {
        break
      }
    }

    if (colonIndex === -1) {
      return { isActive: false, query: '', triggerIndex: -1 }
    }

    // Extract query (text between : and cursor)
    const queryText = beforeCursor.slice(colonIndex + 1)

    // Query must be non-empty (to avoid triggering on a bare colon ":")
    // and must not contain whitespace
    if (!queryText || /\s/.test(queryText)) {
      return { isActive: false, query: '', triggerIndex: -1 }
    }

    // Store current trigger position for dismiss tracking
    currentTriggerRef.current = colonIndex
    return { isActive: true, query: queryText.toLowerCase(), triggerIndex: colonIndex }
  }

  const { isActive, query, triggerIndex } = detectTrigger()

  // Dynamically load emoji data when trigger becomes active
  // Keeps initial bundle clean from ~150KB of emoji data
  useEffect(() => {
    if (isActive && !emojiData) {
      import('@emoji-mart/data')
        .then((m) => {
          setEmojiData(m.default)
        })
        .catch(console.error)
    }
  }, [isActive, emojiData])

  // Build matches list
  const matches = useMemo((): EmojiMatch[] => {
    if (!isActive || !emojiData || !query) return []

    const list: EmojiMatch[] = []
    const emojis = emojiData.emojis
    if (!emojis) return []

    for (const [id, emojiObj] of Object.entries<any>(emojis)) {
      const native = emojiObj.skins?.[0]?.native
      if (!native) continue

      const isIdMatch = id.startsWith(query)
      const isKeywordMatch = emojiObj.keywords?.some((kw: string) => kw.startsWith(query))
      const isNameMatch = emojiObj.name.toLowerCase().includes(query)

      if (isIdMatch || isKeywordMatch || isNameMatch) {
        list.push({ id, name: emojiObj.name, native })
      }
      if (list.length >= 8) break // Limit to 8 matches for UX clean look
    }

    // Sort matches: prioritize exact shortcode match, then prefix matches, then alphabetize
    return list.sort((a, b) => {
      if (a.id === query) return -1
      if (b.id === query) return 1
      if (a.id.startsWith(query) && !b.id.startsWith(query)) return -1
      if (!a.id.startsWith(query) && b.id.startsWith(query)) return 1
      return a.id.localeCompare(b.id)
    })
  }, [isActive, query, emojiData])

  // Reset selection index when matches change
  useEffect(() => {
    setSelectedIndex(0)
  }, [matches.length])

  // Reset dismissed state when a NEW : trigger appears at a different position
  if (dismissed && triggerIndex >= 0 && triggerIndex !== dismissedAtTriggerRef.current) {
    setDismissed(false)
    dismissedAtTriggerRef.current = -1
  }

  const selectMatch = (index: number): { newText: string; newCursorPosition: number } => {
    const match = matches[index]
    if (!match) {
      return { newText: text, newCursorPosition: cursorPosition }
    }

    // Replace :query with the emoji character
    const beforeTrigger = text.slice(0, triggerIndex)
    const afterCursor = text.slice(cursorPosition)
    const replacement = match.native
    const newText = beforeTrigger + replacement + afterCursor
    const newCursorPosition = triggerIndex + replacement.length

    return { newText, newCursorPosition }
  }

  const moveSelection = (direction: 'up' | 'down') => {
    if (matches.length === 0) return

    setSelectedIndex((prev) => {
      if (direction === 'up') {
        return prev <= 0 ? matches.length - 1 : prev - 1
      } else {
        return prev >= matches.length - 1 ? 0 : prev + 1
      }
    })
  }

  const dismiss = () => {
    dismissedAtTriggerRef.current = currentTriggerRef.current
    setDismissed(true)
    setSelectedIndex(0)
  }

  return {
    state: {
      isActive: isActive && matches.length > 0,
      query,
      triggerIndex,
      selectedIndex,
      matches,
    },
    selectMatch,
    moveSelection,
    dismiss,
  }
}
