import type { Message } from '../core/types/chat'
import type { MessageSecurityContext } from '../core/types/message-base'
import type { MessageImplState } from '../core/types/message-internal'

/** Authenticated archive metadata, kept outside the readable message timeline. */
export interface ArchiveSignal {
  conversationId: string
  archiveId: string
  from: string
  id: string
  stanza: string
  timestamp: number
  authoredAt?: number
  securityContext?: MessageSecurityContext
  effect:
    | { type: 'reactions'; targetId: string; emojis: string[] }
    | { type: 'retract'; targetId: string }
    | { type: 'update'; targetId: string; updates: Partial<Message> & MessageImplState; authorOnly: boolean }
}

export interface StoredArchiveSignal extends ArchiveSignal {
  key: string
  /** Zero until a target is present; target write and completion commit together. */
  applied: number
  sequence: number
}

export function archiveSignalKey(conversationId: string, archiveId: string): string {
  return JSON.stringify([conversationId, archiveId])
}
