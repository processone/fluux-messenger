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

interface EmojiAutocompleteDataEntry {
  name: string
  keywords?: string[]
  skins?: Array<{ native?: string }>
}

interface EmojiAutocompleteData {
  emojis?: Record<string, EmojiAutocompleteDataEntry>
}

const MAX_EMOJI_MATCHES = 8

/**
 * Match and rank emoji suggestions independently of the source data's insertion order.
 * Exact shortcode matches come first, followed by shortcode prefixes, keyword prefixes,
 * and name matches. The result limit is applied only after all candidates are ranked.
 */
export function matchEmojiAutocomplete(
  data: EmojiAutocompleteData,
  query: string,
  limit = MAX_EMOJI_MATCHES,
): EmojiMatch[] {
  const normalizedQuery = query.toLowerCase()
  if (!normalizedQuery || limit <= 0 || !data.emojis) return []

  const rankedMatches: Array<EmojiMatch & { rank: number }> = []

  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins?.[0]?.native
    if (!native) continue

    const normalizedId = id.toLowerCase()
    const isExactIdMatch = normalizedId === normalizedQuery
    const isIdPrefixMatch = normalizedId.startsWith(normalizedQuery)
    const isKeywordPrefixMatch = emoji.keywords?.some((keyword) =>
      keyword.toLowerCase().startsWith(normalizedQuery)
    ) ?? false
    const isNameMatch = emoji.name.toLowerCase().includes(normalizedQuery)

    const rank = isExactIdMatch
      ? 0
      : isIdPrefixMatch
        ? 1
        : isKeywordPrefixMatch
          ? 2
          : isNameMatch
            ? 3
            : -1

    if (rank >= 0) {
      rankedMatches.push({ id, name: emoji.name, native, rank })
    }
  }

  return rankedMatches
    .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ id, name, native }) => ({ id, name, native }))
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
  const [emojiData, setEmojiData] = useState<EmojiAutocompleteData | null>(null)

  // Detect : trigger and extract query
  const detectTrigger = (): { isActive: boolean; query: string; triggerIndex: number } => {
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

    // If it's the exact same trigger index we dismissed, remain inactive
    if (dismissed && colonIndex === dismissedAtTriggerRef.current) {
      return { isActive: false, query: queryText.toLowerCase(), triggerIndex: colonIndex }
    }

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

    return matchEmojiAutocomplete(emojiData, query)
  }, [isActive, query, emojiData])

  // Reset selection index when matches change
  useEffect(() => {
    setSelectedIndex(0)
  }, [matches.length])

  // Reset dismissed state when the trigger disappears or changes to a different position
  if (dismissed && (triggerIndex === -1 || (triggerIndex >= 0 && triggerIndex !== dismissedAtTriggerRef.current))) {
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
