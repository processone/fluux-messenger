/**
 * Search utility functions for snippet generation and result formatting.
 *
 * @module SearchUtils
 */

/**
 * Match snippet with position information for UI highlighting.
 */
export interface MatchSnippet {
  /** The snippet text (may be truncated with ellipsis) */
  text: string
  /** Start index of the match within the snippet text */
  matchStart: number
  /** End index of the match within the snippet text */
  matchEnd: number
}

/**
 * Generate a text snippet around the first occurrence of the query in the body.
 *
 * Returns the snippet text with match position indices so the UI can
 * highlight the matched portion (e.g., with `<mark>` or a CSS class).
 *
 * @param body - The full message body text
 * @param query - The search query to find in the body
 * @param contextChars - Number of characters to show before and after the match
 * @returns A snippet with match positions, or null if no match found
 */
export function generateMatchSnippet(
  body: string,
  query: string,
  contextChars = 60,
  phrases?: string[]
): MatchSnippet | null {
  if (!body || !query) return null

  const lowerBody = body.toLowerCase()

  let matchIndex = -1
  let matchLength = 0

  // Priority 1: Try to match a quoted phrase first
  if (phrases && phrases.length > 0) {
    for (const phrase of phrases) {
      const idx = lowerBody.indexOf(phrase.toLowerCase())
      if (idx !== -1) {
        matchIndex = idx
        matchLength = phrase.length
        break
      }
    }
  }

  // Priority 2: Try full query string match
  if (matchIndex === -1) {
    const lowerQuery = query.toLowerCase()
    matchIndex = lowerBody.indexOf(lowerQuery)
    matchLength = query.length
  }

  // Priority 3: Try matching the first query word
  if (matchIndex === -1) {
    const lowerQuery = query.toLowerCase()
    const words = lowerQuery.split(/\s+/).filter((w) => w.length >= 2)
    for (const word of words) {
      matchIndex = lowerBody.indexOf(word)
      if (matchIndex !== -1) {
        matchLength = word.length
        break
      }
    }
  }

  if (matchIndex === -1) return null

  // Calculate snippet boundaries
  const snippetStart = Math.max(0, matchIndex - contextChars)
  const snippetEnd = Math.min(body.length, matchIndex + matchLength + contextChars)

  // Build snippet with ellipsis for truncation
  let text = body.slice(snippetStart, snippetEnd)
  let adjustedMatchStart = matchIndex - snippetStart

  if (snippetStart > 0) {
    text = '…' + text
    adjustedMatchStart += 1 // account for ellipsis character
  }
  if (snippetEnd < body.length) {
    text = text + '…'
  }

  return {
    text,
    matchStart: adjustedMatchStart,
    matchEnd: adjustedMatchStart + matchLength,
  }
}
