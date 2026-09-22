/**
 * The archived flag of the server conversation list (docs/XEP-CONVERSATION_SYNC.md)
 * is user intent. This runs the real chat store, the real MAM preview refresh
 * and the client's own conversation-list publisher together, on a cold profile, to
 * prove that the daily archived-conversation check neither clears the flag
 * locally nor writes the loss back to the server for every other device.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { localStorageMock } from '../sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

import { XMPPClient, getInternalSurfaceForTesting, bindStoresForTesting } from '../XMPPClient'
import { createMockXmppClient, createMockElement, type MockXmppClient } from '../test-utils'
import { createDefaultStoreBindings } from '../defaultStoreBindings'
import { chatStore } from '../../stores/chatStore'
import { connectionStore } from '../../stores/connectionStore'
import { rosterStore } from '../../stores/rosterStore'
import { roomStore } from '../../stores/roomStore'
import { NS_CONVERSATIONS, NS_MAM, NS_PUBSUB, NS_PUBSUB_EVENT } from '../namespaces'

let mockXmppClientInstance: MockXmppClient

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { client as xmppClientFactory } from '@xmpp/client'

const CAROL = 'carol@example.com'

function conversationsItem(archived: boolean) {
  return {
    name: 'item', attrs: { id: 'current' }, children: [{
      name: 'conversations', attrs: { xmlns: NS_CONVERSATIONS }, children: [
        { name: 'conversation', attrs: { jid: CAROL, archived: String(archived) } },
      ],
    }],
  }
}

function notifyConversations(archived: boolean) {
  mockXmppClientInstance._emit('stanza', createMockElement('message', { from: 'me@example.com' }, [{
    name: 'event', attrs: { xmlns: NS_PUBSUB_EVENT }, children: [{
      name: 'items', attrs: { node: NS_CONVERSATIONS }, children: [conversationsItem(archived)],
    }],
  }]))
}

function archivedMessage(queryId: string) {
  return createMockElement('message', {}, [{
    name: 'result', attrs: { xmlns: NS_MAM, queryid: queryId, id: 'archive-carol' }, children: [{
      name: 'forwarded', attrs: { xmlns: 'urn:xmpp:forward:0' }, children: [
        { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-06-15T10:30:00Z' } },
        { name: 'message', attrs: { from: `${CAROL}/phone`, to: 'me@example.com', id: 'carol-1', type: 'chat' },
          children: [{ name: 'body', text: 'Sent before the user archived this' }] },
      ],
    }],
  }])
}

describe('user-archived conversations on a cold profile', () => {
  let xmppClient: XMPPClient
  let publishConversations: ReturnType<typeof vi.spyOn>

  const waitForAsyncOps = async (iterations = 10, timePerIteration = 100) => {
    for (let i = 0; i < iterations; i++) {
      await vi.advanceTimersByTimeAsync(timePerIteration)
      await Promise.resolve()
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    localStorageMock.clear()
    chatStore.getState().reset()
    connectionStore.getState().reset()
    rosterStore.getState().reset()
    roomStore.getState().reset()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, createDefaultStoreBindings())
    // The client installs its own conversation-list publisher on construction;
    // the spy sits on the module it publishes through.
    publishConversations = vi
      .spyOn(getInternalSurfaceForTesting(xmppClient).conversationSync, 'publishConversations')
      .mockResolvedValue(undefined)
  })

  afterEach(() => {
    xmppClient.destroy()
    chatStore.getState().reset()
    connectionStore.getState().reset()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('keeps the flag and never republishes the list without it, even though the latest message is incoming', async () => {
    let stanzaHandler: ((stanza: any) => void) | null = null
    const originalOn = mockXmppClientInstance.on
    mockXmppClientInstance.on = vi.fn((event: string, handler: Function) => {
      if (event === 'stanza') stanzaHandler = handler as (stanza: any) => void
      return originalOn.call(mockXmppClientInstance, event, handler)
    }) as any

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(
      createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [{ name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } }],
        },
      ])
    )
    const connectPromise = xmppClient.connect({
      jid: 'me@example.com',
      password: 'password',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    await waitForAsyncOps()

    // The cold-start merge of the server list: carol was put away by the user,
    // and this profile has never seen a message from her.
    notifyConversations(true)
    expect(chatStore.getState().archivedConversations.has(CAROL)).toBe(true)
    expect(chatStore.getState().conversationMeta.get(CAROL)?.lastMessage).toBeUndefined()
    // The merge itself schedules the debounced publish of the merged list; let
    // it go out so the assertions below see only what the archived check does.
    await waitForAsyncOps(40, 100)
    publishConversations.mockClear()

    mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
      const query = iq?.children?.[0]
      if (query?.attrs?.xmlns === 'urn:xmpp:mam:2') {
        stanzaHandler?.(createMockElement('message', {}, [
          {
            name: 'result',
            attrs: { xmlns: 'urn:xmpp:mam:2', queryid: query.attrs?.queryid, id: 'archive-1' },
            children: [
              {
                name: 'forwarded',
                attrs: { xmlns: 'urn:xmpp:forward:0' },
                children: [
                  { name: 'delay', attrs: { xmlns: 'urn:xmpp:delay', stamp: '2024-06-15T10:30:00Z' } },
                  {
                    name: 'message',
                    attrs: { from: `${CAROL}/phone`, to: 'me@example.com', id: 'carol-1', type: 'chat' },
                    children: [{ name: 'body', text: 'Sent before the user archived this' }],
                  },
                ],
              },
            ],
          },
        ]))
        return createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
        ])
      }
      return createMockElement('iq', { type: 'result' }, [])
    })

    const refresh = getInternalSurfaceForTesting(xmppClient).mam.refreshArchivedConversationPreviews()
    await waitForAsyncOps(20, 100)
    await refresh
    // Past the publisher's debounce, so any dropped flag would have been sent.
    await waitForAsyncOps(40, 100)

    expect(chatStore.getState().archivedConversations.has(CAROL)).toBe(true)
    expect(chatStore.getState().conversationMeta.get(CAROL)?.lastMessage?.body).toBe(
      'Sent before the user archived this',
    )
    for (const [list] of publishConversations.mock.calls) {
      expect(list).toContainEqual({ jid: CAROL, archived: true })
    }
  })

  function installColdStartServer(rosterDelay: number, list: 'unavailable' | 'empty' | 'active') {
    const defaultRequest = mockXmppClientInstance.iqCaller.request.getMockImplementation()!
    const mamRequests = vi.fn()
    const listRequests = vi.fn()
    mockXmppClientInstance.iqCaller.request.mockImplementation((iq: any) => {
      const query = iq.children?.[0]
      const xmlns = query?.attrs?.xmlns
      if (xmlns === 'jabber:iq:roster') {
        return new Promise(resolve => setTimeout(() => resolve(createMockElement('iq', { type: 'result' }, [{
          name: 'query', attrs: { xmlns }, children: [
            { name: 'item', attrs: { jid: CAROL, name: 'Carol Smith', subscription: 'both' } },
          ],
        }])), rosterDelay))
      }
      if (xmlns === NS_PUBSUB && query.children?.[0]?.attrs?.node === NS_CONVERSATIONS) {
        listRequests()
        if (list === 'unavailable') return new Promise(() => {})
        return new Promise(resolve => setTimeout(() => resolve(createMockElement('iq', { type: 'result' }, [{
          name: 'pubsub', attrs: { xmlns: NS_PUBSUB }, children: [{
            name: 'items', attrs: { node: NS_CONVERSATIONS }, children: list === 'empty' ? [] : [conversationsItem(false)],
          }],
        }])), 1_000))
      }
      if (xmlns === 'http://jabber.org/protocol/disco#info') {
        return new Promise(resolve => setTimeout(() => resolve(createMockElement('iq', { type: 'result' }, [{
          name: 'query', attrs: { xmlns }, children: [{ name: 'feature', attrs: { var: NS_MAM } }],
        }])), 2_000))
      }
      if (xmlns === NS_MAM) {
        mamRequests()
        mockXmppClientInstance._emit('stanza', archivedMessage(query.attrs.queryid))
        return Promise.resolve(createMockElement('iq', { type: 'result' }, [
          { name: 'fin', attrs: { xmlns: NS_MAM, complete: 'true' }, children: [] },
        ]))
      }
      return defaultRequest(iq)
    })
    return { mamRequests, listRequests }
  }

  it('keeps an unavailable cold-start list from republishing a discovered archived contact', async () => {
    const { mamRequests, listRequests } = installColdStartServer(1_000, 'unavailable')
    const ready = vi.fn()
    getInternalSurfaceForTesting(xmppClient).on('freshSessionInputsReady', ready)
    const done = xmppClient.connect({
      jid: 'me@example.com', password: 'password', server: 'example.com', skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await vi.advanceTimersByTimeAsync(14_000)
    expect(listRequests).toHaveBeenCalledTimes(1)
    expect(rosterStore.getState().contacts.has(CAROL)).toBe(true)
    expect(ready).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6_000)
    await done

    expect(mamRequests).toHaveBeenCalled()
    expect(chatStore.getState().conversationMeta.get(CAROL)?.lastMessage?.body).toBe(
      'Sent before the user archived this',
    )
    expect(publishConversations).not.toHaveBeenCalled()
    expect(ready).toHaveBeenCalledTimes(1)

    notifyConversations(true)
    chatStore.getState().addConversation({ id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(publishConversations).toHaveBeenCalled()
    expect(chatStore.getState().archivedConversations.has(CAROL)).toBe(true)
    for (const [list] of publishConversations.mock.calls) {
      expect(list).toContainEqual({ jid: CAROL, archived: true })
    }
  })

  it('publishes a contact withheld after a list timeout when a fresh connection fetches an empty list', async () => {
    const firstServer = installColdStartServer(1_000, 'unavailable')
    const options = { jid: 'me@example.com', password: 'password', server: 'example.com', skipDiscovery: true }
    const first = xmppClient.connect(options)
    mockXmppClientInstance._emit('online')
    await vi.advanceTimersByTimeAsync(14_000)
    expect(firstServer.listRequests).toHaveBeenCalledTimes(1)
    expect(rosterStore.getState().contacts.has(CAROL)).toBe(true)
    expect(firstServer.mamRequests).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(6_000)
    await first
    expect(firstServer.mamRequests).toHaveBeenCalled()
    expect(chatStore.getState().conversationEntities.has(CAROL)).toBe(true)
    expect(publishConversations).not.toHaveBeenCalled()

    const disconnected = xmppClient.disconnect()
    await vi.advanceTimersByTimeAsync(100)
    await disconnected
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)
    const secondServer = installColdStartServer(1_000, 'empty')
    const second = xmppClient.connect(options)
    mockXmppClientInstance._emit('online')
    await vi.advanceTimersByTimeAsync(500)
    expect(secondServer.listRequests).toHaveBeenCalledTimes(1)
    expect(publishConversations).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(4_500)
    await second
    expect(publishConversations).toHaveBeenCalledExactlyOnceWith([{ jid: CAROL, archived: false }])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(publishConversations).toHaveBeenCalledTimes(1)
  })

  it('preserves a newer live archive update over a buffered list on a cache-cleared SM resume', async () => {
    const { listRequests } = installColdStartServer(10_000, 'active')
    mockXmppClientInstance.streamManagement.id = 'existing-sm-session'
    const done = xmppClient.connect({
      jid: 'me@example.com', password: 'password', server: 'example.com', skipDiscovery: true,
      smState: { id: 'existing-sm-session', inbound: 0, outbound: 0 },
    })
    mockXmppClientInstance._emit('nonza', createMockElement('resumed', {
      xmlns: 'urn:xmpp:sm:3', previd: 'existing-sm-session', h: '0',
    }))
    await vi.advanceTimersByTimeAsync(3_000)
    notifyConversations(true)
    expect(chatStore.getState().archivedConversations.has(CAROL)).toBe(true)
    await vi.advanceTimersByTimeAsync(12_000)
    await done

    expect(listRequests).toHaveBeenCalledTimes(1)
    expect(chatStore.getState().archivedConversations.has(CAROL)).toBe(true)
    chatStore.getState().addConversation({ id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(publishConversations).toHaveBeenCalled()
    for (const [list] of publishConversations.mock.calls) {
      expect(list).toContainEqual({ jid: CAROL, archived: true })
    }
  })

})
