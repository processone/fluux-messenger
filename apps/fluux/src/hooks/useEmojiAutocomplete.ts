import { useState, useEffect, useMemo, useRef } from 'react'

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
  /** Whether the shortcode was terminated by a closing colon, as in `:+1:`. */
  closed: boolean
  triggerIndex: number
  token: string
  identity: string
}

export interface EmojiCompletion {
  newText: string
  newCursorPosition: number
}

const MAX_EMOJI_MATCHES = 8
/**
 * A single character after the colon is an emoticon (`:D`, `:p`, `:3`), not a
 * shortcode prefix. Matching those would open completion on almost every one and
 * let it swallow the Enter meant to send the message, so require two characters.
 */
const MIN_EMOJI_QUERY_LENGTH = 2

export function normalizeEmojiSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase()
}

/** A database entry flattened to just what matching and rendering need. */
export interface EmojiCandidate {
  id: string
  name: string
  native: string
  keywords?: string[]
}

/** Every emoji matching `query`, plus the query they were matched against. */
export interface EmojiCandidatePool {
  /** Normalized, so it can be compared against the next normalized query. */
  query: string
  candidates: EmojiCandidate[]
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
  if (/\s/.test(token)) return null

  // A trailing colon terminates the shortcode — it is punctuation, not query
  // text — so `:+1:` searches for "+1" the same way `:+1` does.
  const closed = token.endsWith(':')
  const query = closed ? token.slice(0, -1) : token
  // The two-character floor only guards the open form, where `:D` and `:p` are
  // emoticons rather than shortcode prefixes. Nobody types `:v:` as a smiley.
  if (query.length < (closed ? 1 : MIN_EMOJI_QUERY_LENGTH)) return null

  return {
    query: normalizeEmojiSearchText(query),
    closed,
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

/** Length of the shortest keyword the query is a prefix of, or null when none match. */
function shortestKeywordPrefixLength(
  keywords: string[] | undefined,
  normalizedQuery: string,
): number | null {
  let shortest: number | null = null

  for (const keyword of keywords ?? []) {
    const normalized = normalizeEmojiSearchText(keyword)
    if (!normalized.startsWith(normalizedQuery)) continue
    if (shortest === null || normalized.length < shortest) shortest = normalized.length
  }

  return shortest
}

/**
 * Score one candidate against an already-normalized query, or null if it does not match.
 * Exact shortcode matches come first, followed by shortcode prefixes, keyword prefixes,
 * and name matches. Within a tier the query covering more of the matched text wins, so
 * "thumbs" prefers `thumbsup` over `thumbsdown` and "hea" prefers `heart` over
 * `heart_decoration`, rather than falling back to how the shortcodes happen to sort.
 */
function scoreEmojiCandidate(
  candidate: EmojiCandidate,
  normalizedQuery: string,
): { rank: number; matchLength: number } | null {
  const normalizedId = normalizeEmojiSearchText(candidate.id)

  if (normalizedId === normalizedQuery) return { rank: 0, matchLength: normalizedId.length }
  if (normalizedId.startsWith(normalizedQuery)) return { rank: 1, matchLength: normalizedId.length }

  const keywordLength = shortestKeywordPrefixLength(candidate.keywords, normalizedQuery)
  if (keywordLength !== null) return { rank: 2, matchLength: keywordLength }

  const normalizedName = normalizeEmojiSearchText(candidate.name)
  if (normalizedName.includes(normalizedQuery)) return { rank: 3, matchLength: normalizedName.length }

  return null
}

/**
 * Every emoji matching `query`, narrowed from `previous` when possible.
 *
 * Each predicate is monotonic over query prefixes — anything matching `heart`
 * also matches `hea` — so extending a query can only ever shrink the match set,
 * and the next set can be filtered from the previous one instead of rescanning
 * all ~1900 emojis. The guard compares *normalized* queries because NFKC
 * composition is not prefix-preserving: normalized `café` does not start with
 * normalized `cafe`, so there the set grows and only a full scan is correct.
 *
 * The pool deliberately holds every match rather than the visible top eight: a
 * candidate ranked below the cut for a short query can rank first once the query
 * grows, so narrowing a limited set would lose it.
 */
export function emojiCandidatePool(
  data: EmojiAutocompleteData,
  query: string,
  previous?: EmojiCandidatePool,
): EmojiCandidatePool {
  const normalizedQuery = normalizeEmojiSearchText(query)
  const canNarrow =
    previous !== undefined &&
    previous.query.length > 0 &&
    normalizedQuery.startsWith(previous.query)

  if (canNarrow) {
    return {
      query: normalizedQuery,
      candidates: previous.candidates.filter(
        (candidate) => scoreEmojiCandidate(candidate, normalizedQuery) !== null
      ),
    }
  }

  const emojis = data.emojis
  if (!normalizedQuery || !emojis) return { query: normalizedQuery, candidates: [] }

  const candidates: EmojiCandidate[] = []
  for (const [id, emoji] of Object.entries(emojis)) {
    const native = emoji.skins?.[0]?.native
    if (!native) continue

    const candidate: EmojiCandidate = { id, name: emoji.name, native, keywords: emoji.keywords }
    if (scoreEmojiCandidate(candidate, normalizedQuery) !== null) candidates.push(candidate)
  }

  return { query: normalizedQuery, candidates }
}

/** Order a pool's candidates best-match-first. The caller applies any display limit. */
export function rankEmojiCandidates(candidates: EmojiCandidate[], query: string): EmojiMatch[] {
  const normalizedQuery = normalizeEmojiSearchText(query)

  return candidates
    .map((candidate) => ({ candidate, score: scoreEmojiCandidate(candidate, normalizedQuery) }))
    .filter((entry): entry is { candidate: EmojiCandidate; score: { rank: number; matchLength: number } } =>
      entry.score !== null
    )
    .sort(
      (a, b) =>
        a.score.rank - b.score.rank ||
        a.score.matchLength - b.score.matchLength ||
        a.candidate.id.localeCompare(b.candidate.id)
    )
    .map(({ candidate }) => ({ id: candidate.id, name: candidate.name, native: candidate.native }))
}

/**
 * Match and rank emoji suggestions independently of the source data's insertion order.
 * The result limit is applied only after all candidates are ranked.
 */
export function matchEmojiAutocomplete(
  data: EmojiAutocompleteData,
  query: string,
  limit = MAX_EMOJI_MATCHES,
): EmojiMatch[] {
  if (limit <= 0) return []

  return rankEmojiCandidates(emojiCandidatePool(data, query).candidates, query).slice(0, limit)
}

/** The emoji whose shortcode is exactly `query`, used to resolve a closed `:name:`. */
export function findExactEmojiShortcode(
  data: EmojiAutocompleteData,
  query: string,
): EmojiMatch | null {
  const normalizedQuery = normalizeEmojiSearchText(query)
  if (!normalizedQuery || !data.emojis) return null

  for (const [id, emoji] of Object.entries(data.emojis)) {
    const native = emoji.skins?.[0]?.native
    if (native && normalizeEmojiSearchText(id) === normalizedQuery) {
      return { id, name: emoji.name, native }
    }
  }

  return null
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
  selectMatch: (index: number) => EmojiCompletion
  completeClosedShortcode: (text: string, cursorPosition: number) => EmojiCompletion | null
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

  // Extending a query only ever shrinks the match set, so each keystroke filters
  // the previous candidates instead of rescanning the whole database. The cache is
  // a pure optimization — `emojiCandidatePool` falls back to a full scan whenever
  // the previous pool cannot cover the new query — so a stale or dropped entry can
  // only cost time, never change the result.
  const poolRef = useRef<EmojiCandidatePool | undefined>(undefined)
  const matches = useMemo((): EmojiMatch[] => {
    if (!isTriggerActive || !emojiData || !query) return []

    const pool = emojiCandidatePool(emojiData, query, poolRef.current)
    poolRef.current = pool

    return rankEmojiCandidates(pool.candidates, query).slice(0, MAX_EMOJI_MATCHES)
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

  /**
   * Resolve `:name:` the moment the closing colon lands, the way every other
   * chat client does — no menu, no extra keystroke. Takes the incoming text and
   * caret rather than reading state so the caller can apply it during the same
   * change event that produced them.
   */
  const completeClosedShortcode = (
    nextText: string,
    nextCursorPosition: number,
  ): EmojiCompletion | null => {
    if (!emojiData) return null

    const nextTrigger = matchEmojiAutocompleteTrigger(nextText, nextCursorPosition)
    if (!nextTrigger?.closed) return null

    const match = findExactEmojiShortcode(emojiData, nextTrigger.query)
    if (!match) return null

    return {
      newText:
        nextText.slice(0, nextTrigger.triggerIndex) + match.native + nextText.slice(nextCursorPosition),
      newCursorPosition: nextTrigger.triggerIndex + match.native.length,
    }
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
    completeClosedShortcode,
    moveSelection,
    dismiss,
  }
}
