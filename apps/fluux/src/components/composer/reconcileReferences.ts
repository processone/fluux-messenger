import type { MentionReference } from '@fluux/sdk'

/**
 * Carry mention offsets across a text rewrite the editor did not perform itself
 * (a mention or emoji inserted by the composer, a completed `:shortcode:`).
 * Mentions the rewrite touched are dropped, later ones shift by the length
 * change. The rewrite is located as the span between the longest common prefix
 * and suffix; the editor's own edits never come here, they report their mentions.
 */
export function reconcileReferences(
  previous: string,
  next: string,
  references: readonly MentionReference[],
): MentionReference[] {
  if (previous === next) return [...references]
  let start = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (start < maxPrefix && previous[start] === next[start]) start++
  let suffix = 0
  const maxSuffix = maxPrefix - start
  while (suffix < maxSuffix && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++
  const oldEnd = previous.length - suffix
  const delta = next.length - previous.length

  const kept: MentionReference[] = []
  for (const ref of references) {
    if (ref.end <= start) kept.push(ref)
    else if (ref.begin >= oldEnd) kept.push({ ...ref, begin: ref.begin + delta, end: ref.end + delta })
  }
  return kept
}
