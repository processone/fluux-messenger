import { confirmedRoomMessage } from '@/test-utils/roomMessages'
import 'fake-indexeddb/auto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState, type ComponentProps } from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'

// Count MessageComposer renders via a spy module mock.
const composerRenders = { count: 0 }
interface CapturedComposerProps {
  replyingTo?: ReplyInfo | null
  value?: string
  onValueChange?: (value: string) => void
  pendingAttachment?: PendingAttachment | null
  onSend?: (body: string) => Promise<boolean>
  onSendCorrection?: (messageId: string, body: string) => Promise<boolean>
  onRetractMessage?: (messageId: string) => Promise<void>
}
const capturedComposer = { props: null as CapturedComposerProps | null }
vi.mock('./MessageComposer', () => ({
  MessageComposer: (props: CapturedComposerProps) => {
    composerRenders.count++
    capturedComposer.props = props
    return <div data-testid="composer" />
  },
  MESSAGE_INPUT_BASE_CLASSES: '',
  MESSAGE_INPUT_OVERLAY_CLASSES: '',
}))

// RoomMessageInput now builds a slash-command context (useRoomCommandContext ->
// useRoomActions/useRoomModeration/useRoomManagement). Those hooks reach
// useXMPPContext via a relative import inside the SDK package, so mocking the
// @fluux/sdk barrel's useXMPPContext export does not intercept it -- stub the
// three composed hooks directly instead (same pattern as RoomView.test.tsx).
// Keep everything else from the real SDK (the global test-setup mock already
// spreads the actual module).
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useRoomActions: () => ({
      joinRoom: vi.fn(),
      joinResult: vi.fn(),
      leaveRoom: vi.fn(),
    }),
    useRoomModeration: () => ({
      setRole: vi.fn(),
      setAffiliation: vi.fn(),
    }),
    useRoomManagement: () => ({
      setSubject: vi.fn(),
      inviteToRoom: vi.fn(),
    }),
  }
})

import { RoomMessageInput } from './RoomView'
import type { RoomMessage, FileAttachment } from '@fluux/sdk'
import { clearAllMessages, saveRoomMessage, getRoomMessage } from '@fluux/sdk/cache'
import { roomStore } from '@fluux/sdk/stores'
import type { PendingAttachment, ReplyInfo } from './MessageComposer'

vi.unmock('@fluux/sdk/react')

// Stable props defined once so only the parent's own state changes between renders.
const STABLE: ComponentProps<typeof RoomMessageInput> = {
  roomJid: 'room@conf.example.com',
  sendMessage: vi.fn(), sendCorrection: vi.fn(), retractMessage: vi.fn(),
  sendChatState: vi.fn(), sendWhisperChatState: vi.fn(), sendEasterEgg: vi.fn(), sendPoll: vi.fn(),
  replyingTo: null, onCancelReply: vi.fn(), editingMessage: null, onCancelEdit: vi.fn(),
  isConnected: true, sendWhisper: vi.fn(), whisperTarget: null,
}

function Harness() {
  const [, setTick] = useState(0)
  return (
    <>
      <button type="button" onClick={() => setTick((t) => t + 1)}>tick</button>
      <RoomMessageInput {...STABLE} />
    </>
  )
}

describe('RoomMessageInput memoization', () => {
  beforeEach(() => {
    composerRenders.count = 0
    capturedComposer.props = null
  })

  it('does not re-render MessageComposer when the parent re-renders with identical props', () => {
    render(<Harness />)
    const afterMount = composerRenders.count
    fireEvent.click(screen.getByText('tick'))
    fireEvent.click(screen.getByText('tick'))
    expect(composerRenders.count).toBe(afterMount) // memo bailout
  })

  it('uses sender references for corrections and archive references for edit retractions', async () => {
    const sendCorrection = vi.fn().mockResolvedValue(undefined)
    const retractMessage = vi.fn().mockResolvedValue(undefined)
    const editingMessage = {
      id: 'client-id',
      stanzaId: 'archive-id',
      originId: 'origin-id',
      roomJid: STABLE.roomJid,
      from: `${STABLE.roomJid}/Me`,
      nick: 'Me',
      body: 'Original',
      timestamp: new Date(),
      isOutgoing: true,
      type: 'groupchat',
    } satisfies RoomMessage

    render(<RoomMessageInput
      {...STABLE}
      editingMessage={editingMessage}
      sendCorrection={sendCorrection}
      retractMessage={retractMessage}
    />)

    await act(async () => {
      await capturedComposer.props?.onSendCorrection?.('client-id', 'Updated')
      await capturedComposer.props?.onRetractMessage?.('client-id')
    })
    expect(sendCorrection).toHaveBeenCalledWith(STABLE.roomJid, 'origin-id', 'Updated', undefined)
    expect(retractMessage).toHaveBeenCalledWith(STABLE.roomJid, 'archive-id')
  })
})


const stagedOriginal: RoomMessage = confirmedRoomMessage({
  type: 'groupchat', roomJid: STABLE.roomJid, from: `${STABLE.roomJid}/Spammer`, nick: 'Spammer',
  id: 'staged-client', stanzaId: 'staged-archive', occupantId: 'spammer',
  body: 'Staged spam quotation', timestamp: new Date(), isOutgoing: false,
})
const stagedAttachment: PendingAttachment = { file: new File(['photo'], 'photo.png', { type: 'image/png' }) }
const uploadedAttachment: FileAttachment = { url: 'https://files.example.com/photo.png', mediaType: 'image/png', name: 'photo.png', size: 5 }

function moderateStagedReply() {
  roomStore.setState({ messages: new Map([[STABLE.roomJid, [{
    ...stagedOriginal, isRetracted: true, isModerated: true, moderationReason: 'Spam',
  }]]]) })
}

describe('ordinary room sends', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map(), pendingRetractions: new Map(), drafts: new Map() })
  })

  it.each([false, true])('sends without a reply with attachment %s', async attachment => {
    const sendMessage = vi.fn().mockResolvedValue('sent')
    const uploadFile = vi.fn().mockResolvedValue(uploadedAttachment)
    render(<RoomMessageInput {...STABLE} sendMessage={sendMessage} uploadFile={uploadFile}
      pendingAttachment={attachment ? stagedAttachment : null} />)
    act(() => capturedComposer.props!.onValueChange!('Ordinary draft'))
    let sent = false
    await act(async () => { sent = await capturedComposer.props!.onSend!('Ordinary draft') })
    expect(sent).toBe(true)
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(STABLE.roomJid, 'Ordinary draft', expect.objectContaining({
      replyTo: undefined, attachment: attachment ? uploadedAttachment : undefined,
    }))
    expect(uploadFile).toHaveBeenCalledTimes(attachment ? 1 : 0)
  })
})

describe('staged Spam replies', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map([[STABLE.roomJid, [stagedOriginal]]]), drafts: new Map(), pendingRetractions: new Map() })
  })

  it('removes a live Spam quotation without losing the draft or staged attachment', async () => {
    const sendMessage = vi.fn().mockResolvedValue('sent')
    const onCancelReply = vi.fn()
    const uploadFile = vi.fn().mockResolvedValue(uploadedAttachment)
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} onCancelReply={onCancelReply}
      sendMessage={sendMessage} pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
    expect(capturedComposer.props?.replyingTo?.body).toBe(stagedOriginal.body)
    act(() => capturedComposer.props?.onValueChange?.('My draft stays'))
    act(moderateStagedReply)
    expect(capturedComposer.props?.replyingTo).toBeNull()
    expect(onCancelReply).toHaveBeenCalledOnce()
    expect(capturedComposer.props?.value).toBe('My draft stays')
    expect(capturedComposer.props?.pendingAttachment).toBe(stagedAttachment)
    expect(uploadFile).not.toHaveBeenCalled()
    await act(async () => { await capturedComposer.props?.onSend?.('My draft stays') })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'My draft stays', expect.objectContaining({
      replyTo: undefined, attachment: uploadedAttachment,
    }))
  })

  it('checks moderation again after an in-flight attachment upload before sending reply options', async () => {
    let finishUpload!: (attachment: FileAttachment) => void
    const uploadFile = vi.fn(() => new Promise<FileAttachment>(resolve => { finishUpload = resolve }))
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} sendMessage={sendMessage}
      pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
    let sending!: Promise<boolean>
    act(() => { sending = capturedComposer.props!.onSend!('Draft with photo') })
    expect(uploadFile).toHaveBeenCalledWith(stagedAttachment.file)
    act(moderateStagedReply)
    await act(async () => { finishUpload(uploadedAttachment); await sending })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Draft with photo', expect.objectContaining({
      replyTo: undefined, attachment: uploadedAttachment,
    }))
  })

  it('keeps a legitimate staged reply when a different occupant has a colliding client id', async () => {
    roomStore.setState({ messages: new Map([[STABLE.roomJid, [{
      ...stagedOriginal, stanzaId: 'other-archive', occupantId: 'other',
      isRetracted: true, isModerated: true, moderationReason: 'Spam',
    }]]]) })
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} sendMessage={sendMessage} />)
    expect(capturedComposer.props?.replyingTo?.body).toBe(stagedOriginal.body)
    await act(async () => { await capturedComposer.props?.onSend?.('Legitimate reply') })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Legitimate reply', expect.objectContaining({
      replyTo: { id: stagedOriginal.id, stanzaId: stagedOriginal.stanzaId, to: stagedOriginal.from, fallback: { author: stagedOriginal.nick, body: stagedOriginal.body } },
    }))
  })
})


describe('evicted staged replies', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map([[STABLE.roomJid, [stagedOriginal]]]), drafts: new Map(), pendingRetractions: new Map() })
    await saveRoomMessage(stagedOriginal)
  })

  it('omits a stale legacy quotation when its confirmed Spam row is cached behind an unrelated wire-ID hit', async () => {
    const legacy = { ...stagedOriginal, stanzaId: 'foreign', stanzaIdAuthority: undefined }
    await clearAllMessages()
    await saveRoomMessage(legacy)
    roomStore.setState({ messages: new Map([[STABLE.roomJid, [legacy]]]) })
    let finish!: (attachment: FileAttachment) => void
    const uploadFile = vi.fn(() => new Promise<FileAttachment>(resolve => { finish = resolve }))
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={legacy} sendMessage={sendMessage}
      pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
    let sending!: Promise<boolean>
    act(() => { sending = capturedComposer.props!.onSend!('Preserved draft') })
    await act(async () => {
      await saveRoomMessage(stagedOriginal)
      await saveRoomMessage({ ...stagedOriginal, isRetracted: true, isModerated: true, moderationReason: 'Spam' })
      await saveRoomMessage(confirmedRoomMessage({ ...stagedOriginal, id: 'other-client', stanzaId: 'foreign', body: 'Keep B', timestamp: new Date(+stagedOriginal.timestamp + 1000) }))
      roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
      finish(uploadedAttachment)
      await sending
    })
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(STABLE.roomJid, 'Preserved draft', expect.objectContaining({ replyTo: undefined, attachment: uploadedAttachment }))
  })

  function moderateNonresident(reason = 'Spam', targetId = stagedOriginal.stanzaId!, roomJid = STABLE.roomJid) {
    roomStore.setState({ pendingRetractions: new Map([[roomJid, [{
      targetId, actorJid: roomJid, retractedAt: Date.now(),
      moderation: { isModerated: true, moderationReason: reason },
    }]]]) })
  }

  it('hides a quotation moderated after eviction and retains the draft and attachment', async () => {
    const onCancelReply = vi.fn()
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} onCancelReply={onCancelReply}
      pendingAttachment={stagedAttachment} />)
    expect(capturedComposer.props?.replyingTo?.body).toBe(stagedOriginal.body)
    act(() => capturedComposer.props?.onValueChange?.('My retained draft'))
    act(() => roomStore.setState({ messages: new Map() }))
    act(() => moderateNonresident())
    await waitFor(() => expect(capturedComposer.props?.replyingTo).toBeNull())
    expect(onCancelReply).toHaveBeenCalledOnce()
    expect(capturedComposer.props?.value).toBe('My retained draft')
    expect(capturedComposer.props?.pendingAttachment).toBe(stagedAttachment)
  })

  it.each(['pending', 'cache'])('omits evicted Spam from outgoing options after upload using %s knowledge', async source => {
    let finishUpload!: (attachment: FileAttachment) => void
    const uploadFile = vi.fn(() => new Promise<FileAttachment>(resolve => { finishUpload = resolve }))
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} sendMessage={sendMessage}
      pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
    let sending!: Promise<boolean>
    act(() => { sending = capturedComposer.props!.onSend!('Draft with photo') })
    act(() => roomStore.setState({ messages: new Map() }))
    if (source === 'pending') act(() => moderateNonresident())
    else await act(async () => { await saveRoomMessage({ ...stagedOriginal, isRetracted: true, isModerated: true, moderationReason: 'Spam' }) })
    await act(async () => { finishUpload(uploadedAttachment); await sending })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Draft with photo', expect.objectContaining({
      replyTo: undefined, attachment: uploadedAttachment,
    }))
  })

  it.each(['ordinary', 'other-room', 'client-collision', 'occupant-collision'])('retains evicted reply fallbacks for %s', async kind => {
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} sendMessage={sendMessage} />)
    act(() => roomStore.setState({ messages: new Map() }))
    if (kind === 'occupant-collision') {
      await act(async () => { await saveRoomMessage({ ...stagedOriginal, stanzaId: 'another-archive', occupantId: 'another-occupant',
        isRetracted: true, isModerated: true, moderationReason: 'Spam' }) })
    } else act(() => moderateNonresident(kind === 'ordinary' ? 'Off topic' : 'Spam',
      kind === 'client-collision' ? stagedOriginal.id : stagedOriginal.stanzaId!,
      kind === 'other-room' ? 'other@conference.example.com' : STABLE.roomJid))
    await act(async () => { await capturedComposer.props?.onSend?.('Legitimate reply') })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Legitimate reply', expect.objectContaining({
      replyTo: { id: stagedOriginal.id, stanzaId: stagedOriginal.stanzaId, to: stagedOriginal.from, fallback: { author: stagedOriginal.nick, body: stagedOriginal.body } },
    }))
  })
})


it.each(['display', 'upload'])('retains a staged ordinary quotation after cache scrubbing during %s', async mode => {
  await clearAllMessages()
  roomStore.setState({ messages: new Map([[STABLE.roomJid, [stagedOriginal]]]), drafts: new Map(), pendingRetractions: new Map() })
  await saveRoomMessage(stagedOriginal)
  let finishUpload!: (attachment: FileAttachment) => void
  const uploadFile = vi.fn(() => new Promise<FileAttachment>(resolve => { finishUpload = resolve }))
  const sendMessage = vi.fn().mockResolvedValue('sent')
  const onCancelReply = vi.fn()
  render(<RoomMessageInput {...STABLE} replyingTo={stagedOriginal} onCancelReply={onCancelReply}
    sendMessage={sendMessage} pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
  act(() => capturedComposer.props?.onValueChange?.('Retained draft'))
  let sending: Promise<boolean> | undefined
  if (mode === 'upload') act(() => { sending = capturedComposer.props!.onSend!('Retained draft') })
  act(() => roomStore.setState({ messages: new Map() }))
  act(() => roomStore.getState().recordPendingRetraction(STABLE.roomJid, stagedOriginal.stanzaId!, STABLE.roomJid,
    undefined, { isModerated: true, moderationReason: 'Off topic' }))
  await waitFor(async () => expect((await getRoomMessage(STABLE.roomJid, stagedOriginal.id, stagedOriginal.from, stagedOriginal.occupantId))?.body).toBe(''))
  await waitFor(() => expect(roomStore.getState().pendingRetractions.get(STABLE.roomJid)).toBeUndefined())
  await act(async () => {})
  if (mode === 'display') {
    expect(capturedComposer.props?.replyingTo?.body).toBe(stagedOriginal.body)
    expect(capturedComposer.props?.value).toBe('Retained draft')
    expect(capturedComposer.props?.pendingAttachment).toBe(stagedAttachment)
    expect(onCancelReply).not.toHaveBeenCalled()
    act(() => { sending = capturedComposer.props!.onSend!('Retained draft') })
  }
  await act(async () => { finishUpload(uploadedAttachment); await sending })
  expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Retained draft', expect.objectContaining({
    replyTo: { id: stagedOriginal.id, stanzaId: stagedOriginal.stanzaId, to: stagedOriginal.from, fallback: { author: stagedOriginal.nick, body: stagedOriginal.body } },
    attachment: uploadedAttachment,
  }))
})


describe('selected reply archive identity', () => {
  beforeEach(async () => {
    await clearAllMessages()
    roomStore.setState({ messages: new Map(), pendingRetractions: new Map(), drafts: new Map() })
  })

  it.each(['none', 'sibling', 'target'])('preserves the selected archive during upload with %s moderation', async moderated => {
    const sibling = confirmedRoomMessage({ ...stagedOriginal, stanzaId: 'sibling-archive', body: 'Sibling quotation' })
    const selected = confirmedRoomMessage({ ...stagedOriginal, stanzaId: 'selected-archive', body: 'Selected quotation' })
    roomStore.setState({ messages: new Map([[STABLE.roomJid, [sibling, selected]]]) })
    let finish!: (attachment: FileAttachment) => void
    const uploadFile = vi.fn(() => new Promise<FileAttachment>(resolve => { finish = resolve }))
    const sendMessage = vi.fn().mockResolvedValue('sent')
    render(<RoomMessageInput {...STABLE} replyingTo={selected} sendMessage={sendMessage}
      pendingAttachment={stagedAttachment} uploadFile={uploadFile} />)
    let sending!: Promise<boolean>
    act(() => { sending = capturedComposer.props!.onSend!('Keep my draft') })
    if (moderated !== 'none') act(() => roomStore.setState({ pendingRetractions: new Map([[STABLE.roomJid, [{
      targetId: moderated === 'target' ? selected.stanzaId! : sibling.stanzaId!, actorJid: STABLE.roomJid,
      retractedAt: Date.now(), moderation: { isModerated: true, moderationReason: 'Spam' },
    }]]]) }))
    await act(async () => { finish(uploadedAttachment); await sending })
    expect(sendMessage).toHaveBeenCalledWith(STABLE.roomJid, 'Keep my draft', expect.objectContaining({
      attachment: uploadedAttachment,
      replyTo: moderated === 'target' ? undefined : {
        id: selected.id, stanzaId: selected.stanzaId, to: selected.from,
        fallback: { author: selected.nick, body: selected.body },
      },
    }))
    expect(JSON.stringify(sendMessage.mock.calls)).not.toContain(sibling.body)
  })
})
