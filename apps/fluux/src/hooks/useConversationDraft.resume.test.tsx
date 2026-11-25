import { act, renderHook } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { roomStore } from '@fluux/sdk/stores'
import { setStorageScopeJid } from '../../../../packages/fluux-sdk/src/utils/storageScope'
import { useConversationDraft } from './useConversationDraft'
import type { MentionReference } from '@fluux/sdk'
import type { MessageComposerHandle } from '@/components/MessageComposer'

vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')

const ROOM = 'design@conference.example.test'
const BODY = 'Ask @Emma about the review.'
const REFERENCES: MentionReference[] = [{ type: 'mention', begin: 4, end: 9, uri: 'xmpp:emma@example.test' }]

beforeEach(() => {
  setStorageScopeJid('alice@example.test')
  roomStore.getState().reset()
})
afterEach(() => {
  roomStore.getState().reset()
  setStorageScopeJid(null)
})

it('restores the frozen ordinary text, mentions and public qualification instead of the current edit', () => {
  roomStore.getState().setDraft(ROOM, BODY, { ordinary: true })
  let editorText = BODY
  let references: MentionReference[] = []
  let writeText: (value: string) => void = () => {}
  const composerRef: React.RefObject<MessageComposerHandle | null> = { current: {
    getText: () => editorText,
    setText: value => { editorText = value; writeText(value) },
    focus: () => {}, placeCaret: () => {},
  } }
  const state = roomStore.getState()
  const getOrdinary = (id: string, text: string) => state.getDraft(id) === text && roomStore.getState().ordinaryDrafts.has(id)
  const view = renderHook(({ editing }) => useConversationDraft({
    conversationId: ROOM,
    draftOperations: { owner: roomStore, getDraft: state.getDraft, setDraft: state.setDraft, clearDraft: state.clearDraft, getOrdinary },
    composerRef,
    editingConversationId: editing ? ROOM : undefined,
    getReferences: () => references,
    onDraftRecovered: (_text, restored) => { references = restored },
  }), { initialProps: { editing: false } })
  writeText = view.result.current[1]
  references = REFERENCES
  view.rerender({ editing: true })
  act(() => { editorText = 'Unsaved edit of an existing message.'; references = []; view.result.current[1](editorText) })
  act(() => { expect(view.result.current[4]()).toBe(true) })
  view.rerender({ editing: false })
  expect(editorText).toBe(BODY)
  expect(view.result.current[0]).toBe(BODY)
  expect(references).toEqual(REFERENCES)
  expect(roomStore.getState().getDraft(ROOM)).toBe(BODY)
  expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(true)
  view.unmount()
})
