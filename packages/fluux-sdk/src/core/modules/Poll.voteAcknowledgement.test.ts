import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Poll } from './Poll'
import type { Chat } from './Chat'
import type { ModuleDependencies } from './BaseModule'
import type { PollData, SDKEvents } from '../types'
import type { SDKEventSource } from '../types/eventSource'
import { createMockClientWithSDKEvents, createMockPresenceReader, createMockStoreRefs } from '../test-utils'
import { createStoreBindings } from '../../bindings/storeBindings'
import { roomStore } from '../../stores/roomStore'

const ROOM = 'polls@conference.example.com'
const MESSAGE = 'poll-message'
const pollData: PollData = {
  title: 'Lunch?',
  options: [{ emoji: '1️⃣', label: 'Pizza' }, { emoji: '2️⃣', label: 'Soup' }],
  settings: { allowMultiple: false, hideResultsBeforeVote: false },
}

function harness() {
  const events = createMockClientWithSDKEvents()
  const sendReaction = vi.fn<Chat['sendReaction']>().mockResolvedValue(undefined)
  const deps: ModuleDependencies = {
    stores: null,
    presence: createMockPresenceReader(),
    sendStanza: vi.fn(),
    sendIQ: vi.fn(),
    getCurrentJid: () => 'me@example.com',
    emit: vi.fn(),
    emitSDK: events.emit,
    getXmpp: () => null,
  }
  const poll = new Poll(deps, { sendReaction } as unknown as Chat)
  const received: SDKEvents['room:poll-vote'][] = []
  const source: SDKEventSource = events
  source.subscribe('room:poll-vote', payload => received.push(payload))
  return { events, sendReaction, poll, received }
}

describe('poll vote acknowledgements', () => {
  let unbind: (() => void) | undefined

  beforeEach(() => {
    localStorage.clear()
    roomStore.setState({ votedPollIds: new Map() })
  })

  afterEach(() => {
    unbind?.()
    unbind = undefined
    roomStore.setState({ votedPollIds: new Map() })
    localStorage.clear()
  })

  it('emits the sent vote for headless consumers without mutating the global store', async () => {
    const h = harness()

    await h.poll.vote(ROOM, MESSAGE, '1️⃣', [], pollData)

    expect(h.received).toEqual([{ roomJid: ROOM, messageId: MESSAGE, emojis: ['1️⃣'] }])
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(false)
    expect(localStorage.length).toBe(0)
  })

  it.each([
    { name: 'new vote', previous: [], selected: '1️⃣', multiple: false, emojis: ['1️⃣'], acknowledged: true },
    { name: 'replaced vote', previous: ['1️⃣'], selected: '2️⃣', multiple: false, emojis: ['2️⃣'], acknowledged: true },
    { name: 'removed final vote', previous: ['1️⃣'], selected: '1️⃣', multiple: false, emojis: [], acknowledged: false },
    { name: 'remaining multiple vote', previous: ['1️⃣', '2️⃣'], selected: '1️⃣', multiple: true, emojis: ['2️⃣'], acknowledged: true },
    { name: 'remaining non-poll reaction', previous: ['👍', '1️⃣'], selected: '1️⃣', multiple: false, emojis: ['👍'], acknowledged: true },
  ])('applies the $name through store bindings', async ({ previous, selected, multiple, emojis, acknowledged }) => {
    const h = harness()
    const refs = createMockStoreRefs()
    unbind = createStoreBindings(h.events, () => ({ ...refs, room: roomStore.getState() }))
    if (previous.length) roomStore.getState().recordPollVote(ROOM, MESSAGE)
    roomStore.getState().recordPollVote(ROOM, 'another-poll')
    roomStore.getState().recordPollVote('another-room@example.com', MESSAGE)

    await h.poll.vote(ROOM, MESSAGE, selected, previous, {
      ...pollData, settings: { ...pollData.settings, allowMultiple: multiple },
    })

    expect(h.received).toEqual([{ roomJid: ROOM, messageId: MESSAGE, emojis }])
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(acknowledged)
    expect(roomStore.getState().getVotedPollIds(ROOM).has('another-poll')).toBe(true)
    expect(roomStore.getState().getVotedPollIds('another-room@example.com').has(MESSAGE)).toBe(true)
  })

  it('waits for a successful send before acknowledging the vote', async () => {
    const h = harness()
    const refs = createMockStoreRefs()
    unbind = createStoreBindings(h.events, () => ({ ...refs, room: roomStore.getState() }))
    let finish!: () => void
    h.sendReaction.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))

    const sending = h.poll.vote(ROOM, MESSAGE, '1️⃣', [], pollData)
    expect(h.received).toEqual([])
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(false)
    finish()
    await sending

    expect(h.received).toHaveLength(1)
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(true)
  })

  it.each([false, true])('preserves acknowledgement %s when the send fails', async acknowledged => {
    const h = harness()
    const refs = createMockStoreRefs()
    unbind = createStoreBindings(h.events, () => ({ ...refs, room: roomStore.getState() }))
    if (acknowledged) roomStore.getState().recordPollVote(ROOM, MESSAGE)
    const stored = { ...localStorage }
    h.sendReaction.mockRejectedValue(new Error('send failed'))

    await expect(h.poll.vote(ROOM, MESSAGE, '1️⃣', acknowledged ? ['1️⃣'] : [], pollData)).rejects.toThrow('send failed')

    expect(h.received).toEqual([])
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(acknowledged)
    expect({ ...localStorage }).toEqual(stored)
  })

  it('stops applying acknowledgements after the store binding is removed', async () => {
    const h = harness()
    const refs = createMockStoreRefs()
    unbind = createStoreBindings(h.events, () => ({ ...refs, room: roomStore.getState() }))
    unbind()

    await h.poll.vote(ROOM, MESSAGE, '1️⃣', [], pollData)

    expect(h.received).toHaveLength(1)
    expect(roomStore.getState().getVotedPollIds(ROOM).has(MESSAGE)).toBe(false)
  })
})
