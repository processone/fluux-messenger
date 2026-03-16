/**
 * XMPPClient Entity Time Tests
 *
 * Tests for XEP-0202 Entity Time response handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

describe('XMPPClient Entity Time (XEP-0202)', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should register iqCallee handler for time queries', async () => {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    expect(mockXmppClientInstance.iqCallee.get).toHaveBeenCalledWith(
      'urn:xmpp:time',
      'time',
      expect.any(Function)
    )
  })

  it('should return a time element with tzo and utc children', async () => {
    // Set a known time: 2026-03-16T14:30:00Z
    vi.setSystemTime(new Date('2026-03-16T14:30:00Z'))

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    const result = mockXmppClientInstance.iqCallee._call(
      'urn:xmpp:time',
      'time',
      { stanza: {} },
      'get'
    )

    // Should return a time element
    expect(result).toBeTruthy()
    expect(result.name).toBe('time')
    expect(result.attrs.xmlns).toBe('urn:xmpp:time')

    // Should have tzo and utc children
    expect(result.children).toHaveLength(2)

    const tzoChild = result.children.find((c: any) => c.name === 'tzo')
    const utcChild = result.children.find((c: any) => c.name === 'utc')

    expect(tzoChild).toBeTruthy()
    expect(utcChild).toBeTruthy()

    // UTC should match the set time
    expect(utcChild.children[0]).toBe('2026-03-16T14:30:00Z')
  })

  it('should format timezone offset correctly', async () => {
    // Set a known time
    vi.setSystemTime(new Date('2026-03-16T14:30:00Z'))

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    const result = mockXmppClientInstance.iqCallee._call(
      'urn:xmpp:time',
      'time',
      { stanza: {} },
      'get'
    )

    const tzoChild = result.children.find((c: any) => c.name === 'tzo')
    const tzo = tzoChild.children[0] as string

    // Timezone offset should match format +HH:MM or -HH:MM
    expect(tzo).toMatch(/^[+-]\d{2}:\d{2}$/)
  })

  it('should advertise entity time support in disco#info', async () => {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise

    const result = mockXmppClientInstance.iqCallee._call(
      'http://jabber.org/protocol/disco#info',
      'query',
      { stanza: {} },
      'get'
    )

    const features = result.children.filter((c: any) => c.name === 'feature')
    const featureVars = features.map((f: any) => f.attrs.var)
    expect(featureVars).toContain('urn:xmpp:time')
  })
})
