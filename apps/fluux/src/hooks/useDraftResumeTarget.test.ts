import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { chatStore, roomStore } from '@fluux/sdk/stores'
import { setStorageScopeJid } from '../../../../packages/fluux-sdk/src/utils/storageScope'
import { canResumeDraftRequest, type DraftResumeTarget } from './useDraftResumeTarget'

vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')

const ACCOUNT = 'alice@example.test'

beforeEach(() => {
  setStorageScopeJid(ACCOUNT)
  chatStore.getState().reset()
  roomStore.getState().reset()
})
afterEach(() => {
  chatStore.getState().reset()
  roomStore.getState().reset()
  setStorageScopeJid(null)
})

describe('ordinary-draft confirmation ownership', () => {
  for (const kind of ['chat', 'room'] as const) {
    it(`rejects a stale ${kind} owner, account or removed draft before discarding text`, () => {
      const id = kind === 'chat' ? 'emma@example.test' : 'design@conference.example.test'
      if (kind === 'chat') {
        chatStore.getState().addConversation({ id, name: 'Emma', type: 'chat', unreadCount: 0 })
        chatStore.getState().setDraft(id, 'Finish the public review notes.')
        chatStore.getState().setActiveConversation(id)
      } else {
        roomStore.getState().addRoom({ jid: id, name: 'Design', joined: true, nickname: 'You', isBookmarked: true, unreadCount: 0, mentionsCount: 0, typingUsers: new Set(), occupants: new Map() })
        roomStore.getState().setDraft(id, 'Finish the public review notes.', { ordinary: true })
        roomStore.getState().setActiveRoom(id)
      }
      const request: DraftResumeTarget = { kind, id, mode: 'edit', account: ACCOUNT, resume: () => false }
      expect(canResumeDraftRequest(request, request)).toBe(true)
      expect(canResumeDraftRequest(request, { ...request })).toBe(false)
      expect(canResumeDraftRequest(request, null)).toBe(false)
      setStorageScopeJid('bob@example.test')
      expect(canResumeDraftRequest(request, request)).toBe(false)
      setStorageScopeJid(ACCOUNT)
      if (kind === 'chat') chatStore.getState().clearDraft(id)
      else roomStore.getState().clearDraft(id)
      expect(canResumeDraftRequest(request, request)).toBe(false)
    })
  }
})
