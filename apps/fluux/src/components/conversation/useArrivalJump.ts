import { useEffect, useMemo } from 'react'
import { findMessageRowIndex, type MessageRowRef } from '@fluux/sdk'
import { decideArrivalJump, useArrivalJumpStore } from '@/stores/arrivalJumpStore'
import { messageRowId } from './messageRowIdentity'

type Row = Parameters<typeof messageRowId>[0] & { isOutgoing?: boolean }

/**
 * The row an arrival jump lands on: the new-message divider when there is one,
 * otherwise the first incoming message after the read pointer. The divider is
 * only placed for a message that arrives while the window is hidden; one that
 * arrives while the conversation is open above the live edge has none.
 */
export function arrivalTargetRowId(
  messages: readonly Row[],
  firstNewRowId: string | undefined,
  readPointerRow: MessageRowRef | null | undefined,
): string | undefined {
  if (firstNewRowId) return firstNewRowId
  if (!readPointerRow) return undefined
  const pointerIndex = findMessageRowIndex(messages as Parameters<typeof findMessageRowIndex>[0], readPointerRow)
  if (pointerIndex === -1) return undefined
  const next = messages.slice(pointerIndex + 1).find((message) => !message.isOutgoing)
  return next ? messageRowId(next) : undefined
}

/**
 * Carries out a pending arrival jump for the displayed conversation. See
 * {@link useArrivalJumpStore}.
 */
export function useArrivalJump({
  conversationId,
  messages,
  firstNewRowId,
  readPointerRow,
  isCatchingUp,
  lastUserInputAt,
  scrollToMarker,
  requestMessageTarget,
  enabled,
}: {
  conversationId: string
  messages: readonly Row[]
  firstNewRowId: string | undefined
  readPointerRow: MessageRowRef | null | undefined
  isCatchingUp: boolean
  lastUserInputAt: () => number
  scrollToMarker: () => void
  requestMessageTarget: (rowId: string) => void
  enabled: boolean
}): void {
  const jump = useArrivalJumpStore((s) => s.jump)
  const pending = enabled && jump?.conversationId === conversationId
  const targetRowId = useMemo(
    () => (pending ? arrivalTargetRowId(messages, firstNewRowId, readPointerRow) : undefined),
    [pending, messages, firstNewRowId, readPointerRow],
  )

  useEffect(() => {
    if (!pending || !jump) return
    const verdict = decideArrivalJump({
      jump,
      conversationId,
      targetRowId,
      isCatchingUp,
      lastUserInputAt: lastUserInputAt(),
    })
    if (verdict === null || verdict === 'wait') return
    useArrivalJumpStore.getState().clear(jump)
    if (verdict !== 'jump' || !targetRowId) return
    if (targetRowId === firstNewRowId) scrollToMarker()
    else requestMessageTarget(targetRowId)
  }, [pending, jump, conversationId, targetRowId, firstNewRowId, isCatchingUp, lastUserInputAt, scrollToMarker, requestMessageTarget])
}
