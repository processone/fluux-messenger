import { EventEmitter } from 'node:events'
import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildRoomMessageLink, connectionStore, roomStore, type ForwardedCopy, type Room, type RoomMessage } from '@fluux/sdk'
import { ForwardedCopyCard } from './ForwardedCopyCard'

// FLM-336 finding 2: a forward whose link names a room message the reader can read shows that message, and flags a copy that differs.
const { read, mocks } = vi.hoisted(() => ({ read: vi.fn(), mocks: { contacts: new Map<string, { name: string }>() } }))
vi.mock('@fluux/sdk', async original => ({
  ...await original<typeof import('@fluux/sdk')>(),
  useXMPPContext: () => ({ client }),
}))
const events = new EventEmitter()
const client = { messages: { readRoomMessagePreview: read, resolveRoomMessagePreviewTarget: vi.fn() }, subscribe: (event: string, handler: (...args: unknown[]) => void) => {
  events.on(event, handler)
  return () => { events.off(event, handler) }
} }
vi.mock('@fluux/sdk/react', async original => ({
  ...await original<typeof import('@fluux/sdk/react')>(),
  useRosterStore: (select: (s: unknown) => unknown) => select({ contacts: mocks.contacts }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('@/hooks/useNavigateToTarget', () => ({ useNavigateToTarget: () => ({ navigateToConversation: vi.fn() }) }))
vi.mock('@/stores/toastStore', () => ({ useToastStore: (select: (s: unknown) => unknown) => select({ addToast: vi.fn() }) }))
vi.mock('@/utils/deepLinkRouter', () => ({ routeDeepLink: vi.fn() }))

const jid = 'team@conference.example.org'
const real: RoomMessage = { type: 'groupchat', roomJid: jid, id: 'm1', stanzaId: '1731490000123456', originId: undefined,
  from: `${jid}/Bob`, nick: 'Bob', occupantId: 'bob', body: 'The release is on Friday', timestamp: new Date('2026-05-01T10:00:00Z'), isOutgoing: false }
const room: Room = { jid, name: 'Team', nickname: 'Alice', joined: true, isBookmarked: true,
  occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set() }
const link = buildRoomMessageLink(jid, real.stanzaId!)

function card(text: string, joined = true, claimed: Partial<ForwardedCopy> = {}, body = real.body) {
  const fallbackText = `> Bob wrote:\n> ${text}\n${link}`
  const forwarded: ForwardedCopy = { author: 'Mallory', from: `${jid}/Bob`, type: 'groupchat', text, timestamp: 1,
    fallback: { begin: 0, end: fallbackText.length, text: fallbackText }, ...claimed }
  const references = [{ type: 'data' as const, uri: link, begin: fallbackText.length - link.length, end: fallbackText.length }]
  roomStore.getState().addRoom({ ...room, joined }, [{ ...real, body }])
  return render(<ForwardedCopyCard message={{ forwarded, references }} formatTime={() => '18:52'} />)
}

beforeEach(() => {
  vi.resetAllMocks()
  events.removeAllListeners()
  mocks.contacts.clear()
  roomStore.getState().reset()
  connectionStore.getState().setJid('alice@example.org/web')
})
afterEach(() => { roomStore.getState().reset(); connectionStore.getState().setJid(null) })

describe('forwarded copy of a readable room message', () => {
  it('shows the room\'s own message, with no flag, when the copy matches', () => {
    const { container } = card(real.body)
    const el = container.querySelector('[data-forwarded-copy]')!
    expect(el.textContent).toContain('Bob')
    expect(el.textContent).toContain('Team')
    expect(el.textContent).toContain(real.body)
    expect(container.querySelector('[data-forward-differs]')).toBeNull()
  })

  it('shows the real message and flags a copy with other words, keeping the claim visible', () => {
    const { container } = card('Send me your password')
    const el = container.querySelector('[data-forwarded-copy]')!
    const flag = container.querySelector('[data-forward-differs]')!
    expect(flag.textContent).toContain('chat.forwardedCopyDiffers')
    expect(flag.textContent).toContain('Send me your password')
    expect(el.textContent).toContain(real.body)
    // The forged author name is replaced by the room's sender.
    expect(el.textContent).not.toContain('Mallory')
  })

  it('does not flag a copy cut at the length limit that starts the original', () => {
    const long = 'x'.repeat(4001)
    roomStore.getState().reset()
    roomStore.getState().addRoom(room, [{ ...real, body: long + ' and more' }])
    const text = long.slice(0, 4000)
    const forwarded: ForwardedCopy = { author: 'Bob', from: `${jid}/Bob`, type: 'groupchat', text, fallback: { begin: 0, end: link.length, text: link } }
    const { container } = render(<ForwardedCopyCard message={{ forwarded, references: [{ type: 'data', uri: link, begin: 0, end: link.length }] }} formatTime={() => '18:52'} />)
    expect(container.querySelector('[data-forwarded-copy]')!.textContent).toContain('and more')
    expect(container.querySelector('[data-forward-differs]')).toBeNull()
  })

  // Review: the received copy has direction marks dropped, the room body keeps them.
  it('does not flag an honest copy of a body holding direction marks', () => {
    const body = 'shalom \u202Bעולם\u202C\u2066!'
    const { container } = card('shalom עולם!', true, {}, body)
    expect(container.querySelector('[data-forwarded-copy]')!.textContent).toContain('עולם')
    expect(container.querySelector('[data-forward-differs]')).toBeNull()
  })

  it('takes the sender and kind from the room message, not from the copy\'s claim', () => {
    mocks.contacts.set('boss@example.org', { name: 'The Boss' })
    const { container } = card(real.body, true, { author: 'boss@example.org', from: 'boss@example.org', type: 'chat' })
    const el = container.querySelector('[data-forwarded-copy]')!
    expect(el.textContent).toContain('Bob')
    expect(el.textContent).toContain('Team')
    expect(el.textContent).not.toContain('The Boss')
    expect(el.textContent).not.toContain('chat.forwardedCopyDirectChat')
  })

  it('shows the forwarder\'s copy unflagged while the room cannot be read', () => {
    const { container } = card('Send me your password', false)
    const el = container.querySelector('[data-forwarded-copy]')!
    expect(el.textContent).toContain('Mallory')
    expect(el.textContent).toContain('Send me your password')
    expect(container.querySelector('[data-forward-differs]')).toBeNull()
  })
})
