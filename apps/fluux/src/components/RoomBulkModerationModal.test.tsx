import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { roomStore } from '@fluux/sdk/stores'
import { clearAllMessages, saveRoomMessages, getRoomMessageByStanzaId } from '@fluux/sdk/cache'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room, RoomMessage } from '@fluux/sdk'
import { RoomBulkModerationModal, type RoomBulkModerationModalProps } from './RoomBulkModerationModal'
import type { ReactElement } from 'react'

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => {} },
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'rooms.bulkModeration': 'Bulk moderation',
        'rooms.bulkModerationFilter': 'Filter by sender or message text',
        'rooms.bulkModerationSelectAll': 'Select all shown',
        'rooms.bulkModerationReview': 'Review selection',
        'rooms.bulkModerationRemove': 'Remove selected messages',
        'rooms.bulkModerationStop': 'Stop after current message',
        'rooms.bulkModerationSelected': `Selected: ${values?.count}`,
        'rooms.bulkModerationResult': `Removed: ${values?.removed}; failed: ${values?.failed}; skipped: ${values?.skipped}; remaining: ${values?.remaining}`,
        'chat.retry': 'Retry', 'common.close': 'Close', 'common.back': 'Back',
        'chat.moderateReason': 'Reason',
        'rooms.moderationSpam': 'Spam: hide from conversation',
      }
      return labels[key] ?? key
    },
  }),
}))

const room: Room = {
  jid: 'room@conference.example.com', name: 'Room', nickname: 'Me', joined: true,
  supportsModeration: true, isBookmarked: true, unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
  occupants: new Map([['Me', { nick: 'Me', role: 'moderator', affiliation: 'owner' }]]),
}
const message = (id: string, overrides: Partial<RoomMessage> = {}): RoomMessage => {
  const row: RoomMessage = {
    type: 'groupchat', roomJid: room.jid, id: 'reused-client-id', stanzaId: id,
    from: `${room.jid}/Spammer`, nick: 'Spammer', body: id,
    timestamp: new Date('2026-09-11T08:00:00Z'), isOutgoing: false, ...overrides,
  }
  return { ...row, ...overrides }
}
const messages = [message('spam-one'), message('spam-two'), message('legitimate', { nick: 'Friend' })]
const props = { room, messages, isConnected: true, onClose: vi.fn() }
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function selectSpam() {
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter by sender or message text' }), { target: { value: 'spam-' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
}

function renderResident(element: ReactElement<RoomBulkModerationModalProps>) {
  const update = (next: ReactElement<RoomBulkModerationModalProps>) => {
    roomStore.setState({ messages: new Map([[next.props.room.jid, [...next.props.messages]]]) })
  }
  update(element)
  const view = render(element)
  return { ...view, rerender: (next: ReactElement<RoomBulkModerationModalProps>) => {
    act(() => update(next))
    view.rerender(next)
  } }
}

it('selects, reviews and removes selected B when earlier A reuses its client ID', async () => {
  const target = message('shared-archive', { occupantId: 'sender', body: 'Confirmed B', timestamp: new Date(2000) })
  const legacy = { ...target, stanzaId: 'earlier-archive', body: 'Preserved A', timestamp: new Date(1000) }
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  renderResident(<RoomBulkModerationModal {...props} messages={[legacy, target]} moderateMessage={moderateMessage} />)
  expect(screen.getByText(legacy.body)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('checkbox', { name: /Confirmed B/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  expect(screen.getByText('Selected: 1')).toBeInTheDocument()
  expect(screen.getByText(target.body)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove selected messages' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 0; skipped: 0'))
  expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, target.stanzaId, 'Spam')
  expect(roomStore.getState().messages.get(room.jid)?.[0]).toEqual(legacy)
})

it('removes reviewed cached B after eviction while a different archive entry remains resident', async () => {
  const target = message('evicted-archive', { occupantId: 'sender', body: 'Confirmed B', timestamp: new Date(1000) })
  const legacy = { ...target, stanzaId: 'earlier-archive', body: 'Preserved A', timestamp: new Date(2000) }
  await saveRoomMessages([legacy, target])
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  const view = renderResident(<RoomBulkModerationModal {...props} messages={[target, legacy]} moderateMessage={moderateMessage} />)
  fireEvent.click(screen.getByRole('checkbox', { name: /Confirmed B/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  view.rerender(<RoomBulkModerationModal {...props} messages={[legacy]} moderateMessage={moderateMessage} />)
  fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 0; skipped: 0'))
  expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, target.stanzaId, 'Spam')
  expect(roomStore.getState().messages.get(room.jid)).toEqual([legacy])
})

it('reviews and removes only the requested sender beside another archive entry', async () => {
  const target = message('spam-target', { occupantId: 'sender-a' })
  const legacy = message('other-archive', { id: 'legacy-client', occupantId: 'sender-b', body: 'Keep legacy content' })
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  renderResident(<RoomBulkModerationModal {...props} messages={[target, legacy]} initialSender={target} moderateMessage={moderateMessage} />)
  expect(screen.getByText('Selected: 1')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  expect(screen.getByText('spam-target')).toBeInTheDocument()
  expect(screen.queryByText(legacy.body)).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 0; skipped: 0'))
  expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, target.stanzaId, 'Spam')
  expect(roomStore.getState().messages.get(room.jid)?.find(row => row.id === legacy.id)).toEqual(legacy)
})

describe('RoomBulkModerationModal', () => {
  it('revalidates a cleared archive ID before each request in an open batch', async () => {
    const first = deferred()
    const moderateMessage = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(undefined)
    const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    expect(moderateMessage).toHaveBeenCalledTimes(1)
    const second = messages[1]
    const changed = { ...second, stanzaId: undefined }
    view.rerender(<RoomBulkModerationModal {...props} messages={[messages[0], changed]} moderateMessage={moderateMessage} />)
    await act(async () => { first.resolve(); await first.promise })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 0; skipped: 1'))
    expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, 'spam-one', undefined)
  })
  it('accepts a legacy cached target at bulk confirmation', async () => {
    await clearAllMessages()
    const legacy = message('legacy-foreign-id', {  })
    await saveRoomMessages([legacy])
    const cached = (await getRoomMessageByStanzaId(room.jid, legacy.stanzaId!))!
    const moderateMessage = vi.fn().mockResolvedValue(undefined)
    renderResident(<RoomBulkModerationModal {...props} messages={[cached]} moderateMessage={moderateMessage} />)
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
    const confirm = screen.queryByRole('button', { name: 'Remove selected messages' })
    if (confirm) await act(async () => { fireEvent.click(confirm) })
    expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, legacy.stanzaId, undefined)
    expect(await getRoomMessageByStanzaId(room.jid, legacy.stanzaId!)).toMatchObject({ body: legacy.body })
  })
  it('uses the canonical Spam reason for every selected message', async () => {
    const moderateMessage = vi.fn().mockResolvedValue(undefined)
    renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: /Spam.*hide/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 2'))
    expect(moderateMessage.mock.calls).toEqual([
      [room.jid, 'spam-one', 'Spam'], [room.jid, 'spam-two', 'Spam'],
    ])
  })

  it('preselects only the requested sender across nick changes, never a reused nick or missing identity', () => {
    const target = message('target', { occupantId: 'sender-a' })
    renderResident(<RoomBulkModerationModal {...props} initialSender={target} messages={[
      target,
      message('renamed-sender', { occupantId: 'sender-a', nick: 'New nick' }),
      message('different-person', { occupantId: 'sender-b' }),
      message('unknown-identity'),
    ]} moderateMessage={vi.fn()} />)
    expect(screen.getByText('Selected: 2')).toBeInTheDocument()
    expect(screen.getByText('target')).toBeInTheDocument()
    expect(screen.getByText('renamed-sender')).toBeInTheDocument()
    expect(screen.queryByText('different-person')).not.toBeInTheDocument()
    expect(screen.queryByText('unknown-identity')).not.toBeInTheDocument()
    expect(screen.getAllByRole('checkbox').every(input => (input as HTMLInputElement).checked)).toBe(true)
  })

  it('supports individual deselection and previews a poll question before removing it', async () => {
    const moderateMessage = vi.fn().mockResolvedValue(undefined)
    renderResident(<RoomBulkModerationModal {...props} messages={[
      message('poll', { body: '', poll: { title: 'Spam poll?', options: [{ emoji: '1️⃣', label: 'Yes' }], settings: { allowMultiple: false, hideResultsBeforeVote: false } } }),
      message('keep-this'),
    ]} moderateMessage={moderateMessage} />)
    expect(screen.getByText('Spam poll?')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /keep-this/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
    expect(screen.queryByText('keep-this')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
    expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['poll'])
  })

  it('keeps successful targets excluded when returning from a retry review to selection', async () => {
    const moderateMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('server refused'))
    renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('failed: 1'))
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
    expect(screen.getByText('spam-two')).toBeInTheDocument()
  })

  it('reviews exactly the selected messages, uses server ids, and excludes later arrivals', async () => {
    const moderateMessage = vi.fn().mockResolvedValue(undefined)
    const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    expect(moderateMessage).not.toHaveBeenCalled()
    expect(screen.queryByText('legitimate')).not.toBeInTheDocument()
    view.rerender(<RoomBulkModerationModal {...props} messages={[...messages, message('new-spam')]} moderateMessage={moderateMessage} />)
    expect(screen.queryByText('new-spam')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason' }), { target: { value: '  Spam attack  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 2; failed: 0'))
    expect(moderateMessage.mock.calls).toEqual([
      [room.jid, 'spam-one', 'Spam attack'], [room.jid, 'spam-two', 'Spam attack'],
    ])
  })

  it('reports failures and retries only failed messages after another review', async () => {
    const moderateMessage = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('server refused')).mockResolvedValue(undefined)
    renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 1'))
    expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(screen.getByText('spam-two')).toBeInTheDocument()
    expect(moderateMessage).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1; failed: 0'))
    expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-one', 'spam-two', 'spam-two'])
  })

  it('allows one in-flight request and stops before sending the next selected message', async () => {
    const first = deferred()
    const moderateMessage = vi.fn().mockReturnValue(first.promise)
    renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    expect(moderateMessage).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Stop after current message' }))
    await act(async () => { first.resolve() })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('remaining: 1'))
    expect(moderateMessage).toHaveBeenCalledTimes(1)
  })

  it('rechecks live permissions before each request', async () => {
    const first = deferred()
    const moderateMessage = vi.fn().mockReturnValue(first.promise)
    const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    view.rerender(<RoomBulkModerationModal {...props} room={{ ...room, occupants: new Map() }} moderateMessage={moderateMessage} />)
    await act(async () => { first.resolve() })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('skipped: 1'))
    expect(moderateMessage).toHaveBeenCalledTimes(1)
  })

  it('disables confirmation while offline and does not send a remotely retracted target', async () => {
    const moderateMessage = vi.fn().mockResolvedValue(undefined)
    const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    view.rerender(<RoomBulkModerationModal {...props} isConnected={false} moderateMessage={moderateMessage} />)
    expect(screen.getByRole('button', { name: 'Remove selected messages' })).toBeDisabled()
    view.rerender(<RoomBulkModerationModal {...props} messages={[message('spam-one', { isRetracted: true }), ...messages.slice(1)]} moderateMessage={moderateMessage} />)
    expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
    expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-two'])
  })

  it('stops unsent work when the room view unmounts', async () => {
    const first = deferred()
    const moderateMessage = vi.fn().mockReturnValue(first.promise)
    const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
    selectSpam()
    fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
    view.unmount()
    await act(async () => { first.resolve(); await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(moderateMessage).toHaveBeenCalledTimes(1)
  })
})


it.each(['select', 'review'])('retains external retractions after eviction during %s', async phase => {
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
  if (phase === 'review') selectSpam()
  view.rerender(<RoomBulkModerationModal {...props} messages={[message('spam-one', { isRetracted: true,
    isModerated: true, moderationReason: 'Spam' }), ...messages.slice(1)]} moderateMessage={moderateMessage} />)
  expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
  view.rerender(<RoomBulkModerationModal {...props} messages={messages.slice(1)} moderateMessage={moderateMessage} />)
  expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
  if (phase === 'select') selectSpam()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
  expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-two'])
})

it('skips an externally retracted target evicted while another request is in flight', async () => {
  const first = deferred()
  const moderateMessage = vi.fn().mockReturnValue(first.promise)
  const view = renderResident(<RoomBulkModerationModal {...props} moderateMessage={moderateMessage} />)
  selectSpam()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  view.rerender(<RoomBulkModerationModal {...props} messages={[messages[0], message('spam-two', { isRetracted: true,
    isModerated: true, moderationReason: 'Spam' })]} moderateMessage={moderateMessage} />)
  view.rerender(<RoomBulkModerationModal {...props} messages={[messages[0]]} moderateMessage={moderateMessage} />)
  await act(async () => { first.resolve() })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('skipped: 1'))
  expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-one'])
})


beforeEach(async () => {
  await clearAllMessages()
  roomStore.setState({ messages: new Map(), pendingRetractions: new Map() })
})

it.each(['select', 'review'])('reacts to moderation received after eviction during %s', async phase => {
  const room = { ...props.room, jid: `${phase}-evicted@conference.example.com` }
  const messages = props.messages.map(row => message(row.stanzaId!, { id: row.stanzaId!, roomJid: room.jid, from: `${room.jid}/Spammer`, nick: row.nick }))
  const localProps = { ...props, room, messages }
  await saveRoomMessages(messages)
  expect(await getRoomMessageByStanzaId(room.jid, 'spam-two')).toMatchObject({ body: 'spam-two' })
  roomStore.setState({ messages: new Map([[room.jid, messages]]) })
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  const view = render(<RoomBulkModerationModal {...localProps} moderateMessage={moderateMessage} />)
  if (phase === 'review') selectSpam()
  act(() => roomStore.setState({ messages: new Map([[room.jid, messages.slice(1)]]) }))
  view.rerender(<RoomBulkModerationModal {...localProps} messages={messages.slice(1)} moderateMessage={moderateMessage} />)
  expect(screen.getByText('spam-one')).toBeInTheDocument()
  act(() => roomStore.getState().recordPendingRetraction(room.jid, 'spam-one', room.jid, undefined, {
    isModerated: true, moderationReason: 'Spam',
  }))
  await waitFor(() => expect(screen.queryByText('spam-one')).not.toBeInTheDocument())
  await waitFor(() => expect(roomStore.getState().pendingRetractions.get(room.jid)).toBeUndefined())
  expect(await getRoomMessageByStanzaId(room.jid, 'spam-one')).toMatchObject({ isRetracted: true, isModerated: true, moderationReason: 'Spam' })
  expect(screen.queryByText('spam-one')).not.toBeInTheDocument()
  if (phase === 'select') selectSpam()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
  expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-two'])
})

it('skips moderation received after eviction while a prior removal is in flight', async () => {
  const room = { ...props.room, jid: 'running-evicted@conference.example.com' }
  const messages = props.messages.map(row => message(row.stanzaId!, { id: row.stanzaId!, roomJid: room.jid, from: `${room.jid}/Spammer`, nick: row.nick }))
  const localProps = { ...props, room, messages }
  await saveRoomMessages(messages)
  expect(await getRoomMessageByStanzaId(room.jid, 'spam-two')).toMatchObject({ body: 'spam-two' })
  roomStore.setState({ messages: new Map([[room.jid, messages]]) })
  const first = deferred()
  const moderateMessage = vi.fn().mockReturnValue(first.promise)
  const view = render(<RoomBulkModerationModal {...localProps} moderateMessage={moderateMessage} />)
  selectSpam()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(moderateMessage).toHaveBeenCalledTimes(1))
  act(() => roomStore.setState({ messages: new Map([[room.jid, [messages[0]]]]) }))
  view.rerender(<RoomBulkModerationModal {...localProps} messages={[messages[0]]} moderateMessage={moderateMessage} />)
  act(() => roomStore.getState().recordPendingRetraction(room.jid, 'spam-two', room.jid, undefined, {
    isModerated: true, moderationReason: 'Spam',
  }))
  await waitFor(() => expect(roomStore.getState().pendingRetractions.get(room.jid)).toBeUndefined())
  await act(async () => { first.resolve() })
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('skipped: 1'))
  expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['spam-one'])
})


afterEach(() => vi.restoreAllMocks())

it('uses cached moderation in the captured membership without loading history', async () => {
  const room = { ...props.room, jid: 'cached-bulk@conference.example.com' }
  const target = message('cached-target', { id: 'cached-client', roomJid: room.jid, from: `${room.jid}/Spammer` })
  const kept = message('kept', { id: 'kept-client', roomJid: room.jid, from: `${room.jid}/Spammer`, body: 'Kept message' })
  await saveRoomMessages([{ ...target, isRetracted: true, isModerated: true, moderationReason: 'Spam' }, kept])
  const history = vi.spyOn(roomStore.getState(), 'loadOlderMessagesFromCache')
  const fetch = vi.spyOn(globalThis, 'fetch')
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  render(<RoomBulkModerationModal {...props} room={room} messages={[target, kept]} moderateMessage={moderateMessage} />)
  await waitFor(() => expect(screen.queryByText(target.body)).not.toBeInTheDocument())
  expect(screen.getByText(kept.body)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
  expect(moderateMessage.mock.calls.map(call => call[1])).toEqual(['kept'])
  expect(history).not.toHaveBeenCalled()
  expect(fetch).not.toHaveBeenCalled()
})

it('preserves an evicted target when only another room was moderated', async () => {
  const room = { ...props.room, jid: 'scoped-bulk@conference.example.com' }
  const target = message('scoped-target', { id: 'scoped-client', roomJid: room.jid, from: `${room.jid}/Spammer` })
  await saveRoomMessages([target])
  const moderateMessage = vi.fn().mockResolvedValue(undefined)
  const view = render(<RoomBulkModerationModal {...props} room={room} messages={[target]} moderateMessage={moderateMessage} />)
  fireEvent.click(screen.getByRole('button', { name: 'Select all shown' }))
  fireEvent.click(screen.getByRole('button', { name: 'Review selection' }))
  view.rerender(<RoomBulkModerationModal {...props} room={room} messages={[]} moderateMessage={moderateMessage} />)
  act(() => roomStore.setState({ pendingRetractions: new Map([['another@conference.example.com', [{
    targetId: target.stanzaId!, actorJid: 'another@conference.example.com', retractedAt: Date.now(),
    moderation: { isModerated: true, moderationReason: 'Spam' },
  }]]]) }))
  expect(screen.getByText(target.body)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Remove selected messages' }))
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Removed: 1'))
  expect(moderateMessage).toHaveBeenCalledExactlyOnceWith(room.jid, target.stanzaId, undefined)
})
