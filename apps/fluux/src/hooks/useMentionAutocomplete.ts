import { useState, useCallback, useMemo, useRef } from 'react'
import type { RoomOccupant, RoomRole, MentionReference } from '@fluux/sdk'

/**
 * Match entry for autocomplete dropdown
 */
export interface MentionMatch {
  nick: string
  isAll?: boolean // True for @all entry
  role?: RoomRole
}

/**
 * Autocomplete state
 */
export interface MentionAutocompleteState {
  isActive: boolean
  query: string // Text after @ for filtering
  triggerIndex: number // Position of @ in text
  selectedIndex: number // Keyboard navigation index
  matches: MentionMatch[] // Filtered matches (includes @all + occupants)
}

/**
 * Hook for mention autocomplete in MUC rooms
 *
 * Detects @ mentions in text and provides autocomplete suggestions
 * from room occupants and message history authors, plus @all for
 * room-wide mentions. Occupants are listed first, followed by
 * history-only nicks (people who posted but are no longer present).
 *
 * @example
 * ```tsx
 * const { state, selectMatch, moveSelection, dismiss } = useMentionAutocomplete(
 *   text,
 *   cursorPosition,
 *   room.occupants,
 *   room.nickname,
 *   room.jid,
 *   messageNicks
 * )
 * ```
 */
export function useMentionAutocomplete(
  text: string,
  cursorPosition: number,
  occupants: Map<string, RoomOccupant>,
  ownNickname: string,
  roomJid: string,
  messageNicks?: Set<string>
): {
  state: MentionAutocompleteState
  selectMatch: (index: number) => { newText: string; newCursorPosition: number; reference: MentionReference }
  moveSelection: (direction: 'up' | 'down') => void
  dismiss: () => void
} {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissed, setDismissed] = useState(false)
  const dismissedAtTriggerRef = useRef<number>(-1)
  const currentTriggerRef = useRef<number>(-1)

  // Detect @ trigger and extract query
  const { isActive, query, triggerIndex } = useMemo(() => {
    if (dismissed) {
      return { isActive: false, query: '', triggerIndex: currentTriggerRef.current }
    }

    // Look for @ before cursor
    const beforeCursor = text.slice(0, cursorPosition)

    // Find the last @ that could be a mention trigger
    // Must be at start or preceded by whitespace
    let atIndex = -1
    for (let i = beforeCursor.length - 1; i >= 0; i--) {
      if (beforeCursor[i] === '@') {
        // Check if at start or preceded by whitespace
        if (i === 0 || /\s/.test(beforeCursor[i - 1])) {
          atIndex = i
          break
        }
      }
      // Stop if we hit whitespace (@ must be directly before query)
      if (/\s/.test(beforeCursor[i])) {
        break
      }
    }

    if (atIndex === -1) {
      return { isActive: false, query: '', triggerIndex: -1 }
    }

    // Extract query (text between @ and cursor)
    const queryText = beforeCursor.slice(atIndex + 1)

    // Query must not contain whitespace (single word)
    if (/\s/.test(queryText)) {
      return { isActive: false, query: '', triggerIndex: -1 }
    }

    // Store current trigger position for dismiss tracking
    currentTriggerRef.current = atIndex
    // Normalize to NFC so that composed (ë) and decomposed (e + ̈) forms match consistently
    return { isActive: true, query: queryText.normalize('NFC').toLowerCase(), triggerIndex: atIndex }
  }, [text, cursorPosition, dismissed])

  // Build matches list
  const matches = useMemo(() => {
    if (!isActive) return []

    const result: MentionMatch[] = []

    // Add @all if "all" matches query
    if ('all'.startsWith(query)) {
      result.push({ nick: 'all', isAll: true })
    }

    // Filter occupants by nickname prefix (exclude self)
    // Normalize nicknames to NFC for consistent matching across Unicode forms
    const occupantMatches: MentionMatch[] = []
    occupants.forEach((occupant, nick) => {
      if (nick !== ownNickname && nick.normalize('NFC').toLowerCase().startsWith(query)) {
        occupantMatches.push({ nick, role: occupant.role })
      }
    })
    occupantMatches.sort((a, b) => a.nick.localeCompare(b.nick))

    // Add nicks from message history that are not already in occupants
    const historyMatches: MentionMatch[] = []
    if (messageNicks) {
      messageNicks.forEach((nick) => {
        if (nick !== ownNickname && !occupants.has(nick) && nick.normalize('NFC').toLowerCase().startsWith(query)) {
          historyMatches.push({ nick })
        }
      })
      historyMatches.sort((a, b) => a.nick.localeCompare(b.nick))
    }

    return [...result, ...occupantMatches, ...historyMatches]
  }, [isActive, query, occupants, ownNickname, messageNicks])

  // Reset selection when matches change
  useMemo(() => {
    if (selectedIndex >= matches.length) {
      setSelectedIndex(0)
    }
  }, [matches.length, selectedIndex])

  // Reset dismissed state when a NEW @ trigger appears (different position)
  useMemo(() => {
    // Only reset if we have a valid new trigger at a different position than where we dismissed
    if (triggerIndex >= 0 && triggerIndex !== dismissedAtTriggerRef.current) {
      setDismissed(false)
      dismissedAtTriggerRef.current = -1
    }
  }, [triggerIndex])

  const selectMatch = useCallback(
    (index: number): { newText: string; newCursorPosition: number; reference: MentionReference } => {
      const match = matches[index]
      if (!match) {
        throw new Error('Invalid match index')
      }

      // Replace @query with @nick (add space after)
      const beforeTrigger = text.slice(0, triggerIndex)
      const afterCursor = text.slice(cursorPosition)
      const replacement = `@${match.nick} `
      const newText = beforeTrigger + replacement + afterCursor
      const newCursorPosition = triggerIndex + replacement.length

      // Build reference
      // URI is xmpp:room@conf/nick for users, xmpp:room@conf for @all
      const uri = match.isAll ? `xmpp:${roomJid}` : `xmpp:${roomJid}/${match.nick}`
      const reference: MentionReference = {
        begin: triggerIndex,
        end: triggerIndex + 1 + match.nick.length, // @nick (without trailing space)
        type: 'mention',
        uri,
      }

      return { newText, newCursorPosition, reference }
    },
    [matches, text, triggerIndex, cursorPosition, roomJid]
  )

  const moveSelection = useCallback(
    (direction: 'up' | 'down') => {
      if (matches.length === 0) return

      setSelectedIndex((prev) => {
        if (direction === 'up') {
          return prev <= 0 ? matches.length - 1 : prev - 1
        } else {
          return prev >= matches.length - 1 ? 0 : prev + 1
        }
      })
    },
    [matches.length]
  )

  const dismiss = useCallback(() => {
    // Record where we dismissed so we don't immediately reactivate
    dismissedAtTriggerRef.current = currentTriggerRef.current
    setDismissed(true)
    setSelectedIndex(0)
  }, [])

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
