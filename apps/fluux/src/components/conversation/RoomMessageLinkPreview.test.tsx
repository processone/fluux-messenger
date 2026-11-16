import { EventEmitter } from 'node:events'
import { emitMessageCacheUpdate } from '../../../../../packages/fluux-sdk/src/utils/messageCacheUpdates'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRoomMessageLink, connectionStore, roomStore, type BaseMessage, type Room, type RoomMessage } from '@fluux/sdk'
import { RoomMessageLinkPreview } from './RoomMessageLinkPreview'

vi.unmock('@fluux/sdk/react')
const { read, resolveTarget } = vi.hoisted(() => ({ read: vi.fn(), resolveTarget: vi.fn() }))
vi.mock('@fluux/sdk', async original => ({
  ...await original<typeof import('@fluux/sdk')>(),
  useXMPPContext: () => ({ client: client }),
}))
const events = new EventEmitter()
const client = { messages: { readRoomMessagePreview: read, resolveRoomMessagePreviewTarget: resolveTarget }, subscribe: (event: string, handler: (...args: unknown[]) => void) => {
  events.on(event, handler)
  return () => { events.off(event, handler) }
} }
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? ({ 'chat.messageDeleted': 'Message deleted' }[key] ?? key) }) }))

const jid = 'team@conference.example.org'
const target: RoomMessage = { type: 'groupchat', roomJid: jid, id: 'team-update', stanzaId: '1731490000123456', originId: undefined,
  from: `${jid}/Bob`, nick: 'Bob', occupantId: 'bob', body: 'The release notes are ready for review.', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
const room: Room = { jid, name: 'Team', nickname: 'Alice', joined: true, isBookmarked: true,
  occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
const link = buildRoomMessageLink(jid, target.stanzaId!)
const shared: BaseMessage = { type: 'chat', id: 'shared-link', stanzaId: undefined, originId: undefined,
  from: 'bob@example.org', body: link, timestamp: new Date(), isOutgoing: false }
const formatTime = (date: Date) => date.toISOString().slice(11, 16)
function show(message = shared) { return render(<RoomMessageLinkPreview message={message} formatTime={formatTime} />) }

beforeEach(() => {
  vi.resetAllMocks()
  events.removeAllListeners()
  roomStore.getState().reset()
  connectionStore.getState().setJid('alice@example.org/web')
  read.mockResolvedValue({ kind: 'found', message: target })
  // The canonical lookup is a separate SDK boundary; its cache/archive collision
  // behavior is exercised by MAM.messageLink.test.ts with the real reader port.
  resolveTarget.mockImplementation(async (message: RoomMessage, reference: string) => reference === message.id || reference === message.stanzaId
    ? { kind: 'found', message } : { kind: 'absent' })
})
afterEach(() => { roomStore.getState().reset(); connectionStore.getState().setJid(null) })

// Approved piece 2: reader-built quote for members, Join chip otherwise, and
// late archive results must never reveal room content after access/account loss.
describe('room link reader previews', () => {
  it('shows only Join for a non-member, without even reading cached content', () => {
    roomStore.getState().addRoom({ ...room, joined: false }, [target])
    show()
    expect(screen.getByRole('link', { name: 'Team Join the room to see it' }).getAttribute('href')).toBe(link)
    expect(screen.queryByText(target.body)).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('shows a member quote from resident history with sender, time and room', () => {
    roomStore.getState().addRoom(room, [target])
    show()
    expect(screen.getByText('Team')).toBeTruthy()
    expect(screen.getByText('Bob')).toBeTruthy()
    expect(screen.getByText('10:00')).toBeTruthy()
    expect(screen.getByText(target.body)).toBeTruthy()
    expect(read).not.toHaveBeenCalled()
    act(() => roomStore.getState().addRoom({ ...room, joined: false }))
    expect(screen.queryByText(target.body)).toBeNull()
    expect(screen.getByText('Join the room to see it')).toBeTruthy()
  })

  it('prefers a data reference to the body and resolves a missing resident quote read-only', async () => {
    roomStore.getState().addRoom(room)
    const bodyLink = buildRoomMessageLink('design@conference.example.org', '550e8400-e29b-41d4-a716-446655440000')
    show({ ...shared, body: bodyLink, references: [{ type: 'data', uri: link }] })
    await screen.findByText(target.body)
    expect(read).toHaveBeenCalledWith(jid, target.stanzaId, expect.any(AbortSignal))
    expect(screen.getByRole('link').getAttribute('href')).toBe(link)
  })

  it.each(['membership', 'account'])('discards a late quote after changing %s', async change => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    show()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    await act(async () => {
      if (change === 'membership') roomStore.getState().addRoom({ ...room, joined: false })
      else connectionStore.getState().setJid('carol@example.org/web')
      finish({ kind: 'found', message: target })
    })
    expect(screen.queryByText(target.body)).toBeNull()
    expect(screen.getByText('Join the room to see it')).toBeTruthy()
  })

  it.each(['lookup', 'canonical', 'in-flight'])('keeps confirmed %s absence after delayed canonical and resident copies arrive', async source => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'absent' }) => void
    if (source === 'lookup') read.mockResolvedValueOnce({ kind: 'absent' })
    if (source === 'in-flight') read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    show()
    if (source === 'canonical') {
      await screen.findByText(target.body)
      act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org',
        target: { ...target, isRetracted: true, body: '' } }))
    }
    if (source === 'in-flight') {
      await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
      act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target }))
      await screen.findByText(target.body)
      await act(async () => finish({ kind: 'absent' }))
    }
    await screen.findByText('Message deleted')
    await act(async () => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target }))
    expect(screen.getByText('Message deleted')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
    act(() => roomStore.getState().addRoom(room, [target]))
    expect(screen.getByText('Message deleted')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
  })

  it.each([['absent', 'Message deleted'], ['unknown', 'Open message in room']])('distinguishes %s from other lookup outcomes', async (kind, notice) => {
    roomStore.getState().addRoom(room)
    read.mockResolvedValue({ kind })
    show()
    await screen.findByText(notice)
    expect(screen.queryByText(target.body)).toBeNull()
  })

  it('updates a nonresident quote and clears it on an authorized pending retraction', async () => {
    roomStore.getState().addRoom(room)
    show()
    await screen.findByText(target.body)
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
      correctionActor: { actorJid: target.from, actorOccupantId: target.occupantId },
      updates: { body: 'The release notes have been revised.', isEdited: true, liveCorrection: true,
        correctionRevision: { ids: ['origin:revision-one'], supersedes: [], receiveOrder: { session: 'room-preview', sequence: 1 } } } }))
    expect(await screen.findByText('The release notes have been revised.')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
      correctionActor: { actorJid: target.from, actorOccupantId: target.occupantId },
      updates: { body: 'The release notes are final.', isEdited: true, liveCorrection: true,
        correctionRevision: { ids: ['origin:revision-two'], supersedes: [], receiveOrder: { session: 'room-preview', sequence: 2 } } } }))
    expect(await screen.findByText('The release notes are final.')).toBeTruthy()
    act(() => events.emit('room:retraction-pending', { roomJid: jid, targetId: target.stanzaId,
      actorJid: target.from, actorOccupantId: target.occupantId }))
    expect(await screen.findByText('Message deleted')).toBeTruthy()
    expect(screen.queryByText('The release notes are final.')).toBeNull()
  })

  it.each(['correction', 'retraction'])('reconciles a %s received while the first quote read is pending', async kind => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    show()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    act(() => {
      if (kind === 'correction') events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
        updates: { body: 'Revised while loading', isEdited: true } })
      else events.emit('room:retraction-pending', { roomJid: jid, targetId: target.id,
        actorJid: target.from, actorOccupantId: target.occupantId })
    })
    await act(async () => finish({ kind: 'found', message: target }))
    expect(screen.queryByText(target.body)).toBeNull()
    expect(screen.getByText(kind === 'correction' ? 'Revised while loading' : 'Message deleted')).toBeTruthy()
  })

  it('preserves newer quote content when the resident row is evicted during an older cache read', async () => {
    roomStore.getState().addRoom(room, [target])
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    show()
    act(() => roomStore.setState({ messages: new Map() }))
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
      updates: { body: 'Revised after eviction', isEdited: true } }))
    await act(async () => finish({ kind: 'found', message: target }))
    expect(await screen.findByText('Revised after eviction')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.stanzaId,
      updates: { isRetracted: true, body: '' } }))
    expect(await screen.findByText('Message deleted')).toBeTruthy()
  })

  it('does not delete a detached quote when the canonical target is a different message by the same author', async () => {
    roomStore.getState().addRoom(room)
    const other = { ...target, id: 'later-update', stanzaId: '1731490000123500', body: 'Another room update' }
    const quote = { ...target, id: other.stanzaId }
    read.mockResolvedValue({ kind: 'found', message: quote })
    resolveTarget.mockResolvedValue({ kind: 'found', message: other })
    show()
    await screen.findByText(quote.body)
    await act(async () => events.emit('room:retraction-pending', { roomJid: jid, targetId: other.stanzaId,
      actorJid: other.from, actorOccupantId: other.occupantId }))
    expect(screen.getByText(quote.body)).toBeTruthy()
    expect(screen.queryByText('Message deleted')).toBeNull()
  })

  it('aborts the reader request when its quote is unmounted', async () => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = show()
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    const signal = read.mock.calls[0][2] as AbortSignal
    expect(signal.aborted).toBe(false)
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ kind: 'found', message: target }))
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('aborts a pending canonical-target lookup when the quote is unmounted', async () => {
    roomStore.getState().addRoom(room)
    let finish!: (result: { kind: 'found'; message: RoomMessage }) => void
    resolveTarget.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = show()
    await screen.findByText(target.body)
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
      updates: { body: 'A later update', isEdited: true } }))
    await waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(1))
    const signal = resolveTarget.mock.calls[0][2] as AbortSignal
    view.unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => finish({ kind: 'found', message: target }))
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('reconciles a committed nonresident recovery without a message arrival or SDK update', async () => {
    roomStore.getState().addRoom(room)
    show()
    await screen.findByText(target.body)
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org',
      target: { ...target, body: 'Recovered room content' } }))
    expect(await screen.findByText('Recovered room content')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
  })

  it.each([
    ['unknown', 'correction'], ['unknown', 'retraction'], ['rejected', 'correction'], ['rejected', 'retraction'],
  ])('recovers after an %s update lookup through a committed %s', async (failure, recovery) => {
    roomStore.getState().addRoom(room)
    show()
    await screen.findByText(target.body)
    if (failure === 'unknown') resolveTarget.mockResolvedValueOnce({ kind: 'unknown' })
    else resolveTarget.mockRejectedValueOnce(new Error('Archive lookup failed'))
    await act(async () => events.emit('room:message-updated', { roomJid: jid, messageId: target.id,
      updates: { body: 'Unconfirmed text', isEdited: true } }))
    expect(screen.getByText('Open message in room')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
    await act(async () => events.emit('room:message-updated', { roomJid: jid, messageId: 'another-update', updates: { body: 'Unrelated text' } }))
    expect(screen.queryByText(target.body)).toBeNull()
    const committed = { ...target, body: recovery === 'correction' ? 'Confirmed replacement' : '',
      isEdited: recovery === 'correction', isRetracted: recovery === 'retraction' }
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target: committed }))
    expect(await screen.findByText(recovery === 'correction' ? committed.body : 'Message deleted')).toBeTruthy()
    expect(screen.queryByText('Unconfirmed text')).toBeNull()
  })

  it.each(['correction', 'retraction'])('retains an already queued canonical %s after a lookup becomes unknown', async recovery => {
    roomStore.getState().addRoom(room)
    show()
    await screen.findByText(target.body)
    let finish!: (result: { kind: 'unknown' }) => void
    resolveTarget.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    act(() => events.emit('room:message-updated', { roomJid: jid, messageId: target.id, updates: { body: 'Unconfirmed text', isEdited: true } }))
    await waitFor(() => expect(resolveTarget).toHaveBeenCalledTimes(1))
    const committed = { ...target, body: recovery === 'correction' ? 'Queued committed replacement' : '',
      isEdited: recovery === 'correction', isRetracted: recovery === 'retraction' }
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target: committed }))
    await act(async () => finish({ kind: 'unknown' }))
    expect(await screen.findByText(recovery === 'correction' ? committed.body : 'Message deleted')).toBeTruthy()
    expect(screen.queryByText(target.body)).toBeNull()
  })

  it('keeps the winning correction when an older canonical copy arrives after an unknown lookup', async () => {
    roomStore.getState().addRoom(room)
    const newer = { ...target, body: 'Latest verified quote', isEdited: true,
      correctionTimestamp: Date.parse('2026-05-01T10:02:00Z'), correctionTimestampSource: 'delay',
      correctionRevision: { ids: ['origin:newer-edit'], supersedes: [] } }
    const older = { ...target, body: 'Older canonical quote', isEdited: true,
      correctionTimestamp: Date.parse('2026-05-01T10:01:00Z'), correctionTimestampSource: 'delay',
      correctionRevision: { ids: ['origin:older-edit'], supersedes: [] } }
    read.mockResolvedValue({ kind: 'found', message: newer })
    show()
    await screen.findByText(newer.body)
    resolveTarget.mockResolvedValueOnce({ kind: 'unknown' })
    await act(async () => events.emit('room:message-updated', { roomJid: jid, messageId: target.id, updates: { body: 'Unconfirmed text', isEdited: true } }))
    expect(screen.queryByText(newer.body)).toBeNull()
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target: older }))
    expect(await screen.findByText(newer.body)).toBeTruthy()
    expect(screen.queryByText(older.body)).toBeNull()
  })

  it('reestablishes a target from a matching canonical row after the initial read fails', async () => {
    roomStore.getState().addRoom(room)
    read.mockRejectedValueOnce(new Error('Archive lookup failed'))
    show()
    await act(async () => {})
    const other = { ...target, stanzaId: '1731490000123500', body: 'Another target' }
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target: other }))
    expect(screen.queryByText(other.body)).toBeNull()
    act(() => emitMessageCacheUpdate({ kind: 'room', conversationId: jid, account: 'alice@example.org', target: { ...target, body: 'Recovered canonical target' } }))
    expect(await screen.findByText('Recovered canonical target')).toBeTruthy()
  })

  it('ignores updates for other targets and retractions from a different author', async () => {
    roomStore.getState().addRoom(room)
    show()
    await screen.findByText(target.body)
    await act(async () => {
      events.emit('room:message-updated', { roomJid: jid, messageId: 'another-update', updates: { body: 'Unrelated update' } })
      events.emit('room:retraction-pending', { roomJid: jid, targetId: target.id, actorJid: `${jid}/Mallory`, actorOccupantId: 'mallory' })
    })
    expect(screen.getByText(target.body)).toBeTruthy()
  })

  it('reacts to target retraction and never exposes encrypted fallback text', () => {
    roomStore.getState().addRoom(room, [{ ...target, unsupportedEncryption: { name: 'OMEMO', namespace: 'eu.siacs.conversations.axolotl' } }])
    show()
    expect(screen.queryByText(target.body)).toBeNull()
    act(() => roomStore.getState().addRoom(room, [{ ...target, isRetracted: true, body: '' }]))
    expect(screen.getByText('Message deleted')).toBeTruthy()
  })

  it('does not interpret undecrypted or retracted sharing messages', () => {
    const view = show({ ...shared, isRetracted: true })
    expect(screen.queryByRole('link')).toBeNull()
    view.rerender(<RoomMessageLinkPreview message={{ ...shared, unsupportedEncryption: { name: 'OMEMO', namespace: 'eu.siacs.conversations.axolotl' } }} formatTime={formatTime} />)
    expect(screen.queryByRole('link')).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})
