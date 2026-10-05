import { create } from 'zustand'

/**
 * A request to show a conversation's new messages once they arrive.
 *
 * Opening a conversation from a push notification lands before the pushed
 * message: the app reconnects and fetches it after the conversation is shown,
 * so entry restores the saved position instead. The message list consumes
 * this request and jumps to the first new message once catch-up is done.
 */
export interface ArrivalJump {
  conversationId: string
  requestedAt: number
}

/** A message that has not arrived by then is not waited for any longer. */
export const ARRIVAL_JUMP_TTL_MS = 30_000

interface ArrivalJumpState {
  jump: ArrivalJump | null
  request: (conversationId: string, now?: number) => void
  clear: (jump: ArrivalJump) => void
}

let expiry: ReturnType<typeof setTimeout> | undefined

export const useArrivalJumpStore = create<ArrivalJumpState>((set, get) => ({
  jump: null,
  request: (conversationId, now = Date.now()) => {
    const jump = { conversationId, requestedAt: now }
    clearTimeout(expiry)
    expiry = setTimeout(() => get().clear(jump), ARRIVAL_JUMP_TTL_MS)
    set({ jump })
  },
  clear: (jump) => {
    if (get().jump === jump) set({ jump: null })
  },
}))

export type ArrivalJumpVerdict = 'wait' | 'jump' | 'cancel'

/**
 * Jump once this conversation has a new message to show and catch-up is not
 * running. Any reader input after the request means they chose where to
 * read, so the request is dropped.
 */
export function decideArrivalJump(facts: {
  jump: ArrivalJump | null
  conversationId: string
  targetRowId: string | undefined
  isCatchingUp: boolean
  lastUserInputAt: number
}): ArrivalJumpVerdict | null {
  const { jump } = facts
  if (!jump || jump.conversationId !== facts.conversationId) return null
  if (facts.lastUserInputAt > jump.requestedAt) return 'cancel'
  if (facts.isCatchingUp || !facts.targetRowId) return 'wait'
  return 'jump'
}
