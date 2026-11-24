/**
 * Tests for MAM fulltext search capability discovery.
 *
 * Verifies that discoverMAMSearchCapability() detects XEP-0431 support from
 * the disco#info of the user's bare JID (MAM archive endpoint): ejabberd
 * announces the `urn:xmpp:fulltext:0` feature, and a server may instead embed
 * a MAM form listing the namespaced `{urn:xmpp:fulltext:0}fulltext` field.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient, bindStoresForTesting, getInternalSurfaceForTesting } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

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

vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

import { client as xmppClientFactory } from '@xmpp/client'

describe('Discovery MAM Search Capability', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  const waitForAsyncOps = async () => {
    const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
    for (let i = 0; i < 5; i++) {
      await flushOnce()
      await vi.advanceTimersByTimeAsync(10)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const mamForm = (formType: string, extraFields: string[]) => ({
    name: 'x',
    attrs: { xmlns: 'jabber:x:data', type: 'result' },
    children: [
      { name: 'field', attrs: { var: 'FORM_TYPE' }, children: [{ name: 'value', text: formType }] },
      ...['with', 'start', 'end', ...extraFields].map(field => ({ name: 'field', attrs: { var: field } })),
    ],
  })

  const discover = async (children: unknown[]) => {
    const response = createMockElement('iq', { type: 'result' }, [
      { name: 'query', attrs: { xmlns: 'http://jabber.org/protocol/disco#info' }, children },
    ])
    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(response)
    await connect()
    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()
  }

  const connect = async () => {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
  }

  it('detects fulltext support from the XEP-0431 feature (ejabberd shape)', async () => {
    await discover([
      { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
      { name: 'feature', attrs: { var: 'urn:xmpp:fulltext:0' } },
    ])

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: true })
  })

  it('detects fulltext support from the namespaced field in an embedded MAM form', async () => {
    await discover([
      { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
      mamForm('urn:xmpp:mam:2', ['{urn:xmpp:fulltext:0}fulltext']),
    ])

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: true })
  })

  it('ignores a bare fulltext field, which XEP-0431 servers reject', async () => {
    await discover([
      { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
      mamForm('urn:xmpp:mam:2', ['fulltext']),
    ])

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should report no fulltext support when MAM form lacks fulltext field', async () => {
    await discover([
      { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
      mamForm('urn:xmpp:mam:2', []),
    ])

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should report no fulltext support when neither the feature nor a MAM form is present', async () => {
    await discover([{ name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } }])

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should handle disco#info failure gracefully', async () => {
    mockXmppClientInstance.iqCaller.request.mockRejectedValueOnce(new Error('Service unavailable'))
    await connect()

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should ignore non-MAM data forms', async () => {
    await discover([mamForm('urn:xmpp:http:upload:0', ['{urn:xmpp:fulltext:0}fulltext'])])

    // Should not be fooled by the fulltext field in a non-MAM form
    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it.each([
    ['searchArchive', () => getInternalSurfaceForTesting(xmppClient).mam.searchArchive({ query: 'hello' })],
    ['searchRoomArchive', () => getInternalSurfaceForTesting(xmppClient).mam.searchRoomArchive({ query: 'hello', roomJid: 'room@conference.example.com' })],
  ])('%s sends the namespaced XEP-0431 field', async (_name, search) => {
    await connect()
    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }, [
      { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
    ]))

    await search()

    const sent = JSON.stringify(mockXmppClientInstance.iqCaller.request.mock.calls.at(-1)?.[0])
    expect(sent).toContain('"var":"{urn:xmpp:fulltext:0}fulltext"')
    expect(sent).not.toContain('"var":"fulltext"')
  })

  it('searchArchive sends a date span as the MAM start and end fields', async () => {
    await connect()
    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }, [
      { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2', complete: 'true' }, children: [] },
    ]))

    await getInternalSurfaceForTesting(xmppClient).mam.searchArchive({
      query: 'hello', start: '2024-03-04T23:00:00.000Z', end: '2024-03-05T22:59:59.999Z',
    })

    const sent = JSON.stringify(mockXmppClientInstance.iqCaller.request.mock.calls.at(-1)?.[0])
    expect(sent).toContain('"var":"start"},"children":[{"name":"value","attrs":{},"children":["2024-03-04T23:00:00.000Z"]')
    expect(sent).toContain('"var":"end"},"children":[{"name":"value","attrs":{},"children":["2024-03-05T22:59:59.999Z"]')
  })
  it('pages a detached one-to-one search with unchanged bounds and an older cursor, without timeline events', async () => {
    await connect()
    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }, [
      { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2' }, children: [
        { name: 'set', attrs: { xmlns: 'http://jabber.org/protocol/rsm' }, children: [
          { name: 'first', text: 'older-page' },
        ] },
      ] },
    ]))
    emitSDKSpy.mockClear()
    const result = await getInternalSurfaceForTesting(xmppClient).mam.searchConversationByPaging({
      query: '', with: 'alice@example.com', before: 'previous-page', maxPages: 1,
      start: '2024-03-01T00:00:00.000Z', end: '2024-04-01T00:00:00.000Z', filter: () => true,
    })
    const sent = JSON.stringify(mockXmppClientInstance.iqCaller.request.mock.calls.at(-1)?.[0])
    expect(sent).toContain('previous-page')
    expect(sent).toContain('2024-03-01T00:00:00.000Z')
    expect(sent).toContain('2024-04-01T00:00:00.000Z')
    expect(sent).not.toContain('{urn:xmpp:fulltext:0}fulltext')
    expect(result).toMatchObject({ complete: false, page: { first: 'older-page' }, messages: [] })
    const events: string[] = emitSDKSpy.mock.calls.map((call: unknown[]) => String(call[0]))
    expect(events.filter(event => event.startsWith('chat:history-'))).toEqual([])
  })

  it('stops on a stalled archive cursor rather than repeating the same page', async () => {
    await connect()
    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(createMockElement('iq', { type: 'result' }, [
      { name: 'fin', attrs: { xmlns: 'urn:xmpp:mam:2' }, children: [
        { name: 'set', attrs: { xmlns: 'http://jabber.org/protocol/rsm' }, children: [{ name: 'first', text: 'stalled' }] },
      ] },
    ]))
    const before = mockXmppClientInstance.iqCaller.request.mock.calls.length
    const result = await getInternalSurfaceForTesting(xmppClient).mam.searchConversationByPaging({
      query: 'design', with: 'alice@example.com', before: 'stalled', maxPages: 20,
    })
    expect(result.complete).toBe(true)
    expect(mockXmppClientInstance.iqCaller.request.mock.calls.length - before).toBe(1)
  })

})
