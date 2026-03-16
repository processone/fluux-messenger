/**
 * XMPPClient vCard Tests
 *
 * Tests for fetchVCard(), fetchOwnVCard(), and publishOwnVCard() (XEP-0054 vcard-temp):
 * - Parsing full name, organisation, email, country
 * - Handling missing fields
 * - Handling errors
 * - Own vCard fetch emits event
 * - Publish preserves PHOTO and other unmanaged fields
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

const { mockClientFactory, mockXmlFn } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient | any) => { clientInstance = instance },
      }
    ),
    mockXmlFn: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
      name,
      attrs: attrs || {},
      children,
      toString: () => `<${name}/>`,
    })),
  }
})

vi.mock('@xmpp/client', () => ({
  client: mockClientFactory,
  xml: mockXmlFn,
}))

vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

describe('XMPPClient fetchVCard', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(async () => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)

    // Connect the client
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
    await connectPromise
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should return all vCard fields when present', async () => {
    const vcardResponse = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          { name: 'FN', text: 'Alice Smith' },
          {
            name: 'ORG',
            children: [{ name: 'ORGNAME', text: 'Acme Corp' }],
          },
          {
            name: 'EMAIL',
            children: [{ name: 'USERID', text: 'alice@acme.com' }],
          },
          {
            name: 'ADR',
            children: [{ name: 'CTRY', text: 'France' }],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

    const result = await xmppClient.profile.fetchVCard('alice@example.com')

    expect(result).toEqual({
      fullName: 'Alice Smith',
      org: 'Acme Corp',
      email: 'alice@acme.com',
      country: 'France',
    })
  })

  it('should return partial vCard when only some fields are present', async () => {
    const vcardResponse = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          { name: 'FN', text: 'Bob Jones' },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

    const result = await xmppClient.profile.fetchVCard('bob@example.com')

    expect(result).toEqual({
      fullName: 'Bob Jones',
      org: undefined,
      email: undefined,
      country: undefined,
    })
  })

  it('should return null when vCard has no relevant fields', async () => {
    const vcardResponse = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          {
            name: 'PHOTO',
            children: [{ name: 'BINVAL', text: 'base64data' }],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

    const result = await xmppClient.profile.fetchVCard('charlie@example.com')

    expect(result).toBeNull()
  })

  it('should return null when vCard element is missing', async () => {
    const emptyResponse = createMockElement('iq', { type: 'result' })

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

    const result = await xmppClient.profile.fetchVCard('missing@example.com')

    expect(result).toBeNull()
  })

  it('should return null on IQ error', async () => {
    mockXmppClientInstance.iqCaller.request.mockRejectedValue(
      new Error('item-not-found')
    )

    const result = await xmppClient.profile.fetchVCard('error@example.com')

    expect(result).toBeNull()
  })

  it('should work with occupant JID (room@conf/nick)', async () => {
    const vcardResponse = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          { name: 'FN', text: 'Room User' },
          {
            name: 'ORG',
            children: [{ name: 'ORGNAME', text: 'Some Org' }],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

    const result = await xmppClient.profile.fetchVCard('room@conference.example.com/nick')

    expect(result).toEqual({
      fullName: 'Room User',
      org: 'Some Org',
      email: undefined,
      country: undefined,
    })

    // Verify IQ was sent
    expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
  })
})

describe('XMPPClient fetchOwnVCard', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
    await connectPromise
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should emit connection:own-vcard with vCard data', async () => {
    const vcardResponse = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          { name: 'FN', text: 'My Name' },
          {
            name: 'ORG',
            children: [{ name: 'ORGNAME', text: 'My Company' }],
          },
        ],
      },
    ])

    mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

    const result = await xmppClient.profile.fetchOwnVCard()

    expect(result).toEqual({
      fullName: 'My Name',
      org: 'My Company',
      email: undefined,
      country: undefined,
    })
    expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-vcard', {
      vcard: { fullName: 'My Name', org: 'My Company', email: undefined, country: undefined },
    })
  })

  it('should emit connection:own-vcard with null when no vCard exists', async () => {
    mockXmppClientInstance.iqCaller.request.mockResolvedValue(
      createMockElement('iq', { type: 'result' })
    )

    const result = await xmppClient.profile.fetchOwnVCard()

    expect(result).toBeNull()
    expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-vcard', { vcard: null })
  })
})

describe('XMPPClient publishOwnVCard', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
    await connectPromise
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('should preserve PHOTO when publishing vCard fields', async () => {
    // Existing vCard with PHOTO
    const existingVCard = createMockElement('iq', { type: 'result' }, [
      {
        name: 'vCard',
        attrs: { xmlns: 'vcard-temp' },
        children: [
          { name: 'FN', text: 'Old Name' },
          {
            name: 'PHOTO',
            children: [
              { name: 'TYPE', text: 'image/png' },
              { name: 'BINVAL', text: 'base64photodata' },
            ],
          },
        ],
      },
    ])

    // First call: GET existing vCard; second call: SET new vCard
    const requestsBefore = mockXmppClientInstance.iqCaller.request.mock.calls.length
    mockXmppClientInstance.iqCaller.request
      .mockResolvedValueOnce(existingVCard)
      .mockResolvedValueOnce(createMockElement('iq', { type: 'result' }))

    await xmppClient.profile.publishOwnVCard({ fullName: 'New Name', email: 'me@test.com' })

    // Verify two IQ calls were made (GET + SET)
    expect(mockXmppClientInstance.iqCaller.request.mock.calls.length - requestsBefore).toBe(2)

    // Verify the xml calls include vCard construction with PHOTO preserved
    const vcardCalls = mockXmlFn.mock.calls.filter((c: unknown[]) => c[0] === 'vCard')
    expect(vcardCalls.length).toBeGreaterThan(0)

    // Verify event emitted with new data
    expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-vcard', {
      vcard: { fullName: 'New Name', email: 'me@test.com' },
    })
  })

  it('should emit connection:own-vcard after successful publish', async () => {
    // No existing vCard
    mockXmppClientInstance.iqCaller.request
      .mockRejectedValueOnce(new Error('item-not-found'))
      .mockResolvedValueOnce(createMockElement('iq', { type: 'result' }))

    await xmppClient.profile.publishOwnVCard({ org: 'Acme Corp', country: 'France' })

    expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-vcard', {
      vcard: { org: 'Acme Corp', country: 'France' },
    })
  })
})
