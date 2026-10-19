import type { MessageImplState } from '../core/types/message-internal'

type ReactionState = Pick<MessageImplState, 'reactionTimestamps'> & {
  reactions?: Record<string, string[]>
}

export function reactionUpdate(
  target: ReactionState, author: string, emojis: string[], timestamp: number,
): ReactionState {
  if ((target.reactionTimestamps?.[author] ?? -Infinity) > timestamp) {
    return { reactions: target.reactions, reactionTimestamps: target.reactionTimestamps }
  }
  const reactions: Record<string, string[]> = {}
  for (const [emoji, reactors] of Object.entries(target.reactions ?? {})) {
    const remaining = reactors.filter(reactor => reactor !== author)
    if (remaining.length) reactions[emoji] = remaining
  }
  for (const emoji of new Set(emojis)) reactions[emoji] = [...(reactions[emoji] ?? []), author]
  return {
    reactions: Object.keys(reactions).length ? reactions : undefined,
    reactionTimestamps: { ...target.reactionTimestamps, [author]: timestamp },
  }
}

export function mergeReactionState(a: ReactionState, b: ReactionState): ReactionState {
  let merged: ReactionState = { reactions: {} }
  for (const source of [a, b]) {
    for (const [emoji, reactors] of Object.entries(source.reactions ?? {})) {
      merged.reactions![emoji] = [...new Set([...(merged.reactions![emoji] ?? []), ...reactors])].sort()
    }
  }
  const authors = new Set([...Object.keys(a.reactionTimestamps ?? {}), ...Object.keys(b.reactionTimestamps ?? {})])
  for (const author of authors) {
    const source = (a.reactionTimestamps?.[author] ?? -Infinity) > (b.reactionTimestamps?.[author] ?? -Infinity) ? a : b
    const emojis = Object.entries(source.reactions ?? {}).filter(([, reactors]) => reactors.includes(author)).map(([emoji]) => emoji)
    merged = reactionUpdate(merged, author, emojis, source.reactionTimestamps![author])
  }
  return { ...merged, reactions: Object.keys(merged.reactions ?? {}).length ? merged.reactions : undefined }
}
