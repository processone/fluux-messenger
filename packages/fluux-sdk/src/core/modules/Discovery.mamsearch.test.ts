/**
 * Tests for MAM fulltext search capability discovery.
 *
 * Verifies that discoverMAMSearchCapability() correctly detects whether
 * the server supports the `fulltext` field in MAM queries by parsing
 * disco#info responses from the user's bare JID (MAM archive endpoint).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
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
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should detect fulltext support when MAM form includes fulltext field', async () => {
    // disco#info response with MAM data form containing fulltext field
    const response = createMockElement('iq', { type: 'result' }, [
      {
        name: 'query',
        attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        children: [
          { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          {
            name: 'x',
            attrs: { xmlns: 'jabber:x:data', type: 'result' },
            children: [
              {
                name: 'field',
                attrs: { var: 'FORM_TYPE' },
                children: [{ name: 'value', text: 'urn:xmpp:mam:2' }],
              },
              { name: 'field', attrs: { var: 'with' } },
              { name: 'field', attrs: { var: 'start' } },
              { name: 'field', attrs: { var: 'end' } },
              { name: 'field', attrs: { var: 'fulltext' } },
            ],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(response)

    // Connect to set JID
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: true })
  })

  it('should report no fulltext support when MAM form lacks fulltext field', async () => {
    // disco#info response with MAM data form but NO fulltext field
    const response = createMockElement('iq', { type: 'result' }, [
      {
        name: 'query',
        attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        children: [
          { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
          {
            name: 'x',
            attrs: { xmlns: 'jabber:x:data', type: 'result' },
            children: [
              {
                name: 'field',
                attrs: { var: 'FORM_TYPE' },
                children: [{ name: 'value', text: 'urn:xmpp:mam:2' }],
              },
              { name: 'field', attrs: { var: 'with' } },
              { name: 'field', attrs: { var: 'start' } },
              { name: 'field', attrs: { var: 'end' } },
            ],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(response)

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should report no fulltext support when no MAM form is present', async () => {
    // disco#info response with no data forms at all
    const response = createMockElement('iq', { type: 'result' }, [
      {
        name: 'query',
        attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        children: [
          { name: 'feature', attrs: { var: 'urn:xmpp:mam:2' } },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(response)

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should handle disco#info failure gracefully', async () => {
    mockXmppClientInstance.iqCaller.request.mockRejectedValueOnce(new Error('Service unavailable'))

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })

  it('should ignore non-MAM data forms', async () => {
    // disco#info with a data form for a different namespace (not MAM)
    const response = createMockElement('iq', { type: 'result' }, [
      {
        name: 'query',
        attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
        children: [
          {
            name: 'x',
            attrs: { xmlns: 'jabber:x:data', type: 'result' },
            children: [
              {
                name: 'field',
                attrs: { var: 'FORM_TYPE' },
                children: [{ name: 'value', text: 'urn:xmpp:http:upload:0' }],
              },
              { name: 'field', attrs: { var: 'fulltext' } }, // fulltext in wrong form
            ],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(response)

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    await xmppClient.server.discoverMAMSearchCapability()
    await waitForAsyncOps()

    // Should not be fooled by fulltext in a non-MAM form
    expect(emitSDKSpy).toHaveBeenCalledWith('connection:history-search', { supported: false })
  })
})
