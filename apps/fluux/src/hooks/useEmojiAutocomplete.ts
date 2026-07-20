import { useState, useEffect, useMemo } from 'react'

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

export interface EmojiAutocompleteDataEntry {
  name: string
  keywords?: string[]
  skins?: Array<{ native?: string }>
}

export interface EmojiAutocompleteData {
  emojis?: Record<string, EmojiAutocompleteDataEntry>
}

export interface EmojiAutocompleteTrigger {
  query: string
  triggerIndex: number
  token: string
  identity: string
}

const MAX_EMOJI_MATCHES = 8
/**
 * A single character after the colon is an emoticon (`:D`, `:p`, `:3`), not a
 * shortcode prefix. Matching those would open completion on almost every one and
 * let it swallow the Enter meant to send the message, so require two characters.
 */
const MIN_EMOJI_QUERY_LENGTH = 2

function normalizeEmojiSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** Pure: find the emoji shortcode token immediately before the caret. */
export function matchEmojiAutocompleteTrigger(
  text: string,
  cursorPosition: number,
): EmojiAutocompleteTrigger | null {
  const beforeCursor = text.slice(0, cursorPosition)
  let colonIndex = -1

  for (let index = beforeCursor.length - 1; index >= 0; index--) {
    if (beforeCursor[index] === ':') {
      if (index === 0 || /\s/.test(beforeCursor[index - 1])) {
        colonIndex = index
        break
      }
    }

    if (/\s/.test(beforeCursor[index])) break
  }

  if (colonIndex === -1) return null

  const token = beforeCursor.slice(colonIndex + 1)
  if (token.length < MIN_EMOJI_QUERY_LENGTH || /\s/.test(token)) return null

  return {
    query: normalizeEmojiSearchText(token),
    triggerIndex: colonIndex,
    token,
    identity: JSON.stringify([colonIndex, token]),
  }
}

type EmojiAutocompleteDataModule = { default: EmojiAutocompleteData }
type EmojiAutocompleteDataLoader = () => Promise<EmojiAutocompleteDataModule>

/** Load emoji data without leaking import failures into the composer or console. */
export async function loadEmojiAutocompleteData(
  loader: EmojiAutocompleteDataLoader = () => import('@emoji-mart/data'),
): Promise<EmojiAutocompleteData | null> {
  try {
    const module = await loader()
    return module.default
  } catch {
    return null
  }
}

/** Keep asynchronous data loading independent from trigger parsing and result matching. */
function useEmojiAutocompleteData(enabled: boolean): EmojiAutocompleteData | null {
  const [emojiData, setEmojiData] = useState<EmojiAutocompleteData | null>(null)

  useEffect(() => {
    if (!enabled || emojiData) return

    let cancelled = false
    void loadEmojiAutocompleteData().then((data) => {
      if (!cancelled && data) setEmojiData(data)
    })

    return () => {
      cancelled = true
    }
  }, [enabled, emojiData])

  return emojiData
}

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
  const normalizedQuery = normalizeEmojiSearchText(query)
  if (!normalizedQuery || limit <= 0 || !data.emojis) return []

  const rankedMatches: Array<EmojiMatch & { rank: number }> = []

  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins?.[0]?.native
    if (!native) continue

    const normalizedId = normalizeEmojiSearchText(id)
    const isExactIdMatch = normalizedId === normalizedQuery
    const isIdPrefixMatch = normalizedId.startsWith(normalizedQuery)
    const isKeywordPrefixMatch = emoji.keywords?.some((keyword) =>
      normalizeEmojiSearchText(keyword).startsWith(normalizedQuery)
    ) ?? false
    const isNameMatch = normalizeEmojiSearchText(emoji.name).includes(normalizedQuery)

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
  /** `null` when the caret is unknown for the current text — no trigger is possible. */
  cursorPosition: number | null,
): {
  state: EmojiAutocompleteState
  selectMatch: (index: number) => { newText: string; newCursorPosition: number }
  moveSelection: (direction: 'up' | 'down') => void
  dismiss: () => void
} {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [dismissedTriggerIdentity, setDismissedTriggerIdentity] = useState<string | null>(null)
  const trigger = useMemo(
    () => (cursorPosition === null ? null : matchEmojiAutocompleteTrigger(text, cursorPosition)),
    [text, cursorPosition],
  )
  const triggerIdentity = trigger?.identity ?? null
  const isTriggerActive = trigger !== null && triggerIdentity !== dismissedTriggerIdentity
  const query = trigger?.query ?? ''
  const triggerIndex = trigger?.triggerIndex ?? -1
  const emojiData = useEmojiAutocompleteData(isTriggerActive)

  // Build matches list
  const matches = useMemo((): EmojiMatch[] => {
    if (!isTriggerActive || !emojiData || !query) return []

    return matchEmojiAutocomplete(emojiData, query)
  }, [isTriggerActive, query, emojiData])

  // A changed token represents a new completion interaction, even at the same position.
  useEffect(() => {
    setSelectedIndex(0)
    setDismissedTriggerIdentity((dismissedIdentity) =>
      dismissedIdentity !== null && dismissedIdentity !== triggerIdentity
        ? null
        : dismissedIdentity
    )
  }, [triggerIdentity])

  const selectMatch = (index: number): { newText: string; newCursorPosition: number } => {
    const match = matches[index]
    if (!match || cursorPosition === null) {
      return { newText: text, newCursorPosition: cursorPosition ?? text.length }
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
    setDismissedTriggerIdentity(triggerIdentity)
    setSelectedIndex(0)
  }

  return {
    state: {
      isActive: isTriggerActive && matches.length > 0,
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
