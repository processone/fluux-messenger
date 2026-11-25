import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { roomStore } from '@fluux/sdk/stores'
import { useConversationDraft } from './useConversationDraft'
import type { MessageComposerHandle } from '@/components/MessageComposer'

vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')

const ROOM = 'design@conference.example.test'
const TEXT = 'Please keep the staffing discussion between us.'

beforeEach(() => roomStore.getState().reset())

function mountDraft() {
  let text = roomStore.getState().getDraft(ROOM)
  let qualification = roomStore.getState().ordinaryDrafts.has(ROOM)
  const composerRef: React.RefObject<MessageComposerHandle | null> = { current: {
    getText: () => text,
    setText: value => { text = value },
    focus: () => {},
    placeCaret: () => {},
  } }
  const state = roomStore.getState()
  const getOrdinary = (_id: string, value: string) => value === text && qualification
  const view = renderHook(() => useConversationDraft({
    conversationId: ROOM,
    draftOperations: { owner: roomStore, getDraft: state.getDraft, setDraft: state.setDraft, clearDraft: state.clearDraft, getOrdinary },
    composerRef,
    onDraftRecovered: (_text, _references, value) => { qualification = value === true },
  }))
  return {
    ...view,
    clearComposer: () => { text = ''; view.result.current[1]('') },
    editPublicly: (value: string) => { text = value; qualification = true; view.result.current[1](value) },
  }
}

describe('approved room-draft qualification during recovery', () => {
  for (const ordinary of [false, true]) {
    it(`preserves ${ordinary ? 'public' : 'unclassified'} submitted text through an empty remount`, () => {
      roomStore.getState().setDraft(ROOM, TEXT, { ordinary })
      const first = mountDraft()
      let recover!: () => boolean
      act(() => { recover = first.result.current[2]() })
      act(first.clearComposer)
      first.unmount()
      expect(roomStore.getState().getDraft(ROOM)).toBe('')
      const reopened = mountDraft()
      act(() => { recover() })
      expect(roomStore.getState().getDraft(ROOM)).toBe(TEXT)
      expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(ordinary)
      reopened.unmount()
      expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(ordinary)
    })
  }

  it('keeps a merged draft unclassified when its recovered portion has no public origin', () => {
    roomStore.getState().setDraft(ROOM, TEXT)
    const view = mountDraft()
    let recover!: () => boolean
    act(() => { recover = view.result.current[2]() })
    act(view.clearComposer)
    act(() => view.editPublicly('New public review notes.'))
    act(() => { recover() })
    expect(roomStore.getState().getDraft(ROOM)).toBe(`New public review notes.\n\n${TEXT}`)
    expect(roomStore.getState().ordinaryDrafts.has(ROOM)).toBe(false)
    view.unmount()
  })
})
