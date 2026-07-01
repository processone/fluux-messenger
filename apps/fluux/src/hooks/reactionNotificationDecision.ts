export interface ReactionEvent {
  conversationId: string
  messageId: string
  reactorName: string
  emojis: string[]
  isLive: boolean
}

export interface ReactionContext {
  activeConversationId: string | null
  isLastMessage: boolean
  isOwnOutgoing: boolean
}

export type ReactionDecision = { kind: 'none' } | { kind: 'toast' } | { kind: 'mention' }

/**
 * Pure decision function: given a reaction event and current UI context,
 * determine how (if at all) to notify the user.
 *
 * Rules:
 * - none  if !isLive (MAM replay), no emojis, or not our own outgoing message
 * - none  if the conversation is active AND the reacted message is the last one
 *         (the reaction badge in the message bubble is sufficient feedback)
 * - mention if the conversation is active AND the reacted message is NOT the last
 * - toast  if the conversation is not active at all
 */
export function decideReactionNotification(ev: ReactionEvent, ctx: ReactionContext): ReactionDecision {
  if (!ev.isLive || ev.emojis.length === 0 || !ctx.isOwnOutgoing) return { kind: 'none' }

  if (ev.conversationId === ctx.activeConversationId) {
    return ctx.isLastMessage ? { kind: 'none' } : { kind: 'mention' }
  }

  return { kind: 'toast' }
}
