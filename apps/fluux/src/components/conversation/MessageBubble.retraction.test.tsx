/* eslint-disable @typescript-eslint/triple-slash-reference -- the app's type-check lacks the SDK's ambient module declaration */
/// <reference path="../../../../../packages/fluux-sdk/src/types/xmpp-xml.d.ts" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml } from '@xmpp/client'
import { MessageBubble, type MessageBubbleProps } from './MessageBubble'
import { chatStore } from '../../../../../packages/fluux-sdk/src/stores/chatStore'
import { Chat } from '../../../../../packages/fluux-sdk/src/core/modules/Chat'
import { MAM } from '../../../../../packages/fluux-sdk/src/core/modules/MAM'
import { createStoreBindings, type StoreRefs } from '../../../../../packages/fluux-sdk/src/bindings/storeBindings'
import { createMockClientWithSDKEvents, createMockPresenceReader, createMockStoreRefs, createMockStores } from '../../../../../packages/fluux-sdk/src/core/test-utils'
import * as messageCache from '../../../../../packages/fluux-sdk/src/utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../../../../packages/fluux-sdk/src/utils/storageScope'
import { _resetForTesting } from '../../../../../packages/fluux-sdk/src/stores/shared/throttledStorage'
import { _clearAllTransientForTesting } from '../../../../../packages/fluux-sdk/src/stores/shared/transientUnread'
import type { Message } from '@fluux/sdk'
import type { ModuleDependencies } from '../../../../../packages/fluux-sdk/src/core/modules/BaseModule'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))
vi.mock('date-fns', () => ({ format: vi.fn(() => '14:30') }))
// Without a copy the room link shows its own preview, which needs a live connection this test does not have.
vi.mock('./RoomMessageLinkPreview', () => ({ RoomMessageLinkPreview: () => null }))
vi.mock('../Avatar', () => ({ Avatar: () => <div data-testid="avatar" /> }))
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: { densityMode: string }) => unknown) => selector({ densityMode: 'comfortable' }),
}))

// Review: deletion of a mounted message, driven through the SDK's own send and receive entry points and its
// store bindings, hides the copy on screen and updates the durable row without any manual save.
const NSF = 'urn:xmpp:forward:0'
const NS_RETRACT = 'urn:xmpp:message-retract:1'
const peer = 'bob@example.org'
const room = 'team@conference.example.org'

function wire() {
  const client = createMockClientWithSDKEvents()
  const live = new Proxy({}, { get: (_t, key) => (chatStore.getState() as never)[key] }) as StoreRefs['chat']
  createStoreBindings(client as never, () => ({ ...createMockStoreRefs(), chat: live }) as unknown as StoreRefs)
  const stores = createMockStores()
  stores.chat.getMessage = ((...args: unknown[]) => (chatStore.getState().getMessage as (...a: unknown[]) => unknown)(...args)) as never
  const deps = { stores, presence: createMockPresenceReader(), getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza: vi.fn(), sendIQ: vi.fn(), emit: vi.fn(),
    emitSDK: (event: string, payload: unknown) => (client.emit as (e: string, p: unknown) => void)(event, payload) } as unknown as ModuleDependencies
  return new Chat(deps, new MAM(deps))
}

const original = (id: string) => xml('message', { type: 'chat', id, from: `${peer}/web`, to: 'alice@example.org' },
  xml('body', {}, 'Look'), xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it'))))
const retraction = (id: string) => xml('message', { type: 'chat', id: `r-${id}`, from: `${peer}/web`, to: 'alice@example.org' },
  xml('retract', { xmlns: NS_RETRACT, id }), xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: NS_RETRACT }), xml('body', {}, 'retracted'))

const props = (message: Message): MessageBubbleProps => ({
  message, showAvatar: true, isLastOutgoing: false, isLastMessage: false, senderName: 'Bob', senderColor: 'rgb(1,1,1)',
  avatarIdentifier: peer, myReactions: [], onReaction: vi.fn(), getReactorName: vi.fn(id => id),
  onReply: vi.fn(), onEdit: vi.fn(), onDelete: vi.fn().mockResolvedValue(undefined), formatTime: () => '14:30', timeFormat: '24h',
})
const resident = (id: string) => chatStore.getState().messages.get(peer)?.find(m => m.id === id) as Message
const row = async (id: string) => (await messageCache.getMessages(peer, {})).find(m => m.id === id)

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  _resetStorageScopeForTesting()
  messageCache._resetDBForTesting()
  setStorageScopeJid('alice@example.org')
  _resetForTesting()
  _clearAllTransientForTesting()
  localStorage.clear()
  chatStore.setState({
    conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(), messages: new Map(),
    activeConversationId: peer, windowAtLiveEdge: new Map(), pendingRetractions: new Map(),
    conversationCoverage: new Map(), conversationGaps: new Map(), mamQueryStates: new Map(),
  })
  chatStore.getState().addConversation({ id: peer, type: 'chat', name: 'Bob', unreadCount: 0 })
})
afterEach(() => { _resetForTesting(); messageCache._resetDBForTesting() })

describe('retracting a message that shows a forwarded copy', () => {
  it.each([
    ['sent from this client (sendRetraction)', 'local'],
    ['received from the sender', 'received'],
    ['received before the message and replayed on its arrival', 'replayed'],
  ])('hides the copy on screen and clears the durable row when it is %s', async (_name, mode) => {
    const chat = wire()
    let id = 'gone'
    if (mode === 'replayed') chat.handle(retraction(id))
    if (mode === 'local') id = await chat.sendMessage(peer, 'Look', { forwarded: { from: `${room}/Bob`, text: 'Ship it' } })
    else chat.handle(original(id))
    const view = render(<MessageBubble {...props(resident(id))} />)
    if (mode !== 'replayed') {
      expect(view.container.querySelector('[data-forwarded-copy]')?.textContent).toContain('Ship it')
      // The arrival is written to the durable row by the store itself.
      await vi.waitFor(async () => expect((await row(id))?.forwarded).toMatchObject({ text: 'Ship it' }))
    }

    if (mode === 'local') await chat.sendRetraction(peer, id)
    else if (mode === 'received') chat.handle(retraction(id))

    expect(resident(id)).toMatchObject({ isRetracted: true, forwarded: undefined })
    view.rerender(<MessageBubble {...props(resident(id))} />)
    expect(view.container.querySelector('[data-forwarded-copy]')).toBeNull()
    expect(screen.queryByText(/Ship it/)).toBeNull()
    await vi.waitFor(async () => {
      expect((await row(id))?.isRetracted).toBe(true)
      expect((await row(id))?.forwarded).toBeUndefined()
    })

    chatStore.setState({ messages: new Map() })
    await chatStore.getState().loadMessagesFromCache(peer, { limit: 50 })
    expect(resident(id)).toMatchObject({ isRetracted: true })
    expect(resident(id).forwarded).toBeUndefined()
    view.rerender(<MessageBubble {...props(resident(id))} />)
    expect(view.container.querySelector('[data-forwarded-copy]')).toBeNull()
  })
})

// Rework: the quote a forward carries is hidden only while its copy is shown.
describe('the quote that stands in for a forwarded copy', () => {
  const quote = '> Bob wrote:\n> Ship it\n'
  const forwardBody = `Look\n${quote}xmpp:${room}?join;msg=1`
  const forward = (id: string, withCopy: boolean) => xml('message', { type: 'chat', id, from: `${peer}/web`, to: 'alice@example.org' },
    xml('body', {}, forwardBody),
    ...(withCopy ? [xml('forwarded', { xmlns: NSF }, xml('message', { from: `${room}/Bob` }, xml('body', {}, 'Ship it')))] : []),
    xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: NSF }, xml('body', { start: '5', end: String(Array.from(forwardBody).length) })))
  const bubble = (id: string) => render(<MessageBubble {...props(resident(id))} />).container

  it('shows the comment and the copy, and not the quote, while the copy is shown', () => {
    const chat = wire()
    chat.handle(forward('with-copy', true))
    const view = bubble('with-copy')
    expect(view.querySelector('[data-forwarded-copy]')?.textContent).toContain('Ship it')
    expect(view.textContent).toContain('Look')
    expect(view.textContent).not.toContain('> Bob wrote:')
  })

  it('shows the whole body when the copy is missing, as after an archive that strips extensions', () => {
    const chat = wire()
    chat.handle(forward('no-copy', false))
    const view = bubble('no-copy')
    expect(view.querySelector('[data-forwarded-copy]')).toBeNull()
    expect(view.textContent).toContain('Bob wrote:')
    expect(view.textContent).toContain('Ship it')
  })

  it('shows no copy and no hidden text once the message is retracted', () => {
    const chat = wire()
    chat.handle(forward('retracted', true))
    chat.handle(retraction('retracted'))
    const view = bubble('retracted')
    expect(view.querySelector('[data-forwarded-copy]')).toBeNull()
    expect(view.textContent).not.toContain('Ship it')
  })
})
