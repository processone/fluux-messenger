import type { BaseMessage } from '@fluux/sdk'

type ModerationState = Pick<BaseMessage, 'isRetracted' | 'isModerated' | 'moderationReason'>

/** Match the whole free-text reason after trimming and case folding; see README.md, Messaging. */
export function isSpamModerated(message: ModerationState): boolean {
  return message.isRetracted === true && message.isModerated === true &&
    message.moderationReason?.trim().toLowerCase() === 'spam'
}
