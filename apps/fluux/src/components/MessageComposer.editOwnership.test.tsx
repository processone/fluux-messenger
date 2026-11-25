import { useRef, useState } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { roomStore } from '@fluux/sdk/stores'
import type { MentionReference } from '@fluux/sdk'
import { useConversationDraft } from '@/hooks/useConversationDraft'
import { MessageComposer, type EditInfo, type MessageComposerHandle } from './MessageComposer'

vi.unmock('@fluux/sdk')
vi.unmock('@fluux/sdk/stores')

const ROOM = 'design@conference.example.test'
const BODY = 'Ask @Emma about the review.'
const REFERENCES: MentionReference[] = [{ type: 'mention', begin: 4, end: 9, uri: 'xmpp:emma@example.test' }]

beforeEach(() => roomStore.getState().reset())
afterEach(() => roomStore.getState().reset())

for (const action of ['correction', 'retraction'] as const) {
  it(`keeps the resumed ordinary text and mentions when an earlier ${action} finishes`, async () => {
    roomStore.getState().setDraft(ROOM, BODY, { ordinary: true })
    let finish!: () => void
    const completion = new Promise<void>(resolve => { finish = resolve })
    let restoredReferences: MentionReference[] = REFERENCES
    let submittedKind: string | null = null
    const getOrdinary = (id: string, value: string) => roomStore.getState().getDraft(id) === value && roomStore.getState().ordinaryDrafts.has(id)
    function Harness() {
      const [editing, setEditing] = useState<EditInfo | null>(null)
      const composerRef = useRef<MessageComposerHandle>(null)
      const state = roomStore.getState()
      const [text, setText, , , restore] = useConversationDraft({
        conversationId: ROOM,
        draftOperations: { owner: roomStore, getDraft: state.getDraft, setDraft: state.setDraft, clearDraft: state.clearDraft, getOrdinary },
        composerRef,
        editingConversationId: editing ? ROOM : undefined,
        getReferences: () => restoredReferences,
        onDraftRecovered: (_text, references) => { restoredReferences = references },
      })
      return <>
        <button type="button" onClick={() => { restoredReferences = REFERENCES; setEditing({ id: 'sent-review', body: 'Earlier review reply.' }) }}>Edit earlier reply</button>
        <button type="button" onClick={() => { restore(); setEditing(null) }}>Open ordinary draft</button>
        <MessageComposer ref={composerRef} placeholder="Review message" value={text}
          onValueChange={setText}
          editingMessage={editing} onCancelEdit={() => setEditing(null)} onSend={async () => false}
          onSendCorrection={async () => { submittedKind = 'correction'; await completion; return true }}
          onRetractMessage={async () => { submittedKind = 'retraction'; await completion }} />
      </>
    }
    render(<Harness />)
    const input = screen.getByPlaceholderText('Review message')
    fireEvent.click(screen.getByRole('button', { name: 'Edit earlier reply' }))
    restoredReferences = []
    fireEvent.change(input, { target: { value: action === 'correction' ? 'Updated review reply.' : '' } })
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' }) })
    expect(submittedKind).toBe(action)
    fireEvent.click(screen.getByRole('button', { name: 'Open ordinary draft' }))
    expect(input).toHaveValue(BODY)
    await act(async () => { finish(); await completion })
    expect(input).toHaveValue(BODY)
    expect(roomStore.getState().getDraft(ROOM)).toBe(BODY)
    expect(restoredReferences).toEqual(REFERENCES)
  })
}
