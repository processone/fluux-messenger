import { useLayoutEffect, useRef } from 'react'
import { chatStore, roomStore, getStorageScopeJid } from '@fluux/sdk'

export interface DraftResumeTarget {
  kind: 'chat' | 'room'
  id: string
  mode: 'edit' | 'whisper'
  hasAttachment?: boolean
  account: string | null
  resume: () => boolean
}

export type RegisterDraftResume = (target: DraftResumeTarget) => () => void

export function useDraftResumeTarget(
  register: RegisterDraftResume | undefined,
  kind: DraftResumeTarget['kind'],
  id: string,
  mode: DraftResumeTarget['mode'] | null,
  buffer: object | null,
  resume: () => boolean,
  hasAttachment = false,
): void {
  const latestResume = useRef(resume)
  latestResume.current = resume
  const account = getStorageScopeJid()
  // A different edited message or private recipient invalidates an open confirmation.
  useLayoutEffect(() => {
    if (!register || !mode || !buffer) return
    return register({ kind, id, mode, account, hasAttachment, resume: () => latestResume.current() })
  }, [register, kind, id, mode, buffer, account, hasAttachment])
}

export function canResumeDraftRequest(request: DraftResumeTarget, current: DraftResumeTarget | null): boolean {
  // A confirmation can outlive its owner or draft; it must never discard another buffer.
  if (request !== current || request.account !== getStorageScopeJid()) return false
  if (request.kind === 'chat') {
    const state = chatStore.getState()
    return state.activeConversationId === request.id
      && state.conversations.get(request.id)?.type === 'chat'
      && !state.isArchived(request.id) && !!state.getDraft(request.id).trim()
  }
  const state = roomStore.getState()
  return state.activeRoomJid === request.id && !!state.getRoom(request.id)?.joined
    && state.ordinaryDrafts.has(request.id) && !!state.getDraft(request.id).trim()
}
