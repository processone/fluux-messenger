import type { BaseMessage } from '../core/types'

/**
 * The part of a body that only stands in for the forwarded copy the reader shows, or undefined.
 * The marker remembers the exact text it marked, so a body that was edited, replaced or
 * recovered since (by any path) no longer matches and the whole body stays visible.
 */
export function forwardedCopyQuoteRange(
  message: Pick<BaseMessage, 'body' | 'forwarded' | 'isRetracted'>,
): { begin: number; end: number } | undefined {
  const marked = message.forwarded?.fallback
  if (!marked || message.isRetracted || marked.begin >= marked.end) return undefined
  return message.body.slice(marked.begin, marked.end) === marked.text ? { begin: marked.begin, end: marked.end } : undefined
}
