/**
 * Tests for Stream Management patches applied in Connection.createXmppClient()
 *
 * These tests verify:
 * 1. SM ack debouncing: coalesce multiple <r/> responses into one <a/>
 * 2. SM ackQueue desync fix: prevent crash when outbound queue is empty
 *    after page reload (xmppjs/xmpp.js#1119)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

// Use vi.hoisted to create the mock factory at hoist time
const { mockClientFactory, mockXmlFn } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient) => { clientInstance = instance },
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

const { mockDiscoverWebSocket } = vi.hoisted(() => ({
  mockDiscoverWebSocket: vi.fn(),
}))

vi.mock('../../utils/websocketDiscovery', () => ({
  discoverWebSocket: mockDiscoverWebSocket,
}))

/**
 * Enhance the mock SM to look like a real xmpp.js SM module.
 * The patches check for outbound_q (array) and emit (function) to
 * distinguish real SM from test mocks.
 */
function makeSmLikeReal(mockClient: MockXmppClient) {
  const smMock = mockClient.streamManagement as any
  smMock.outbound_q = []
  smMock.outbound = 0
  smMock.requestAckDebounce = 250
  // Add a real emit function (EventEmitter-like)
  const handlers: Record<string, Function[]> = {}
  smMock.emit = vi.fn((event: string, ...args: any[]) => {
    handlers[event]?.forEach(h => h(...args))
    return true
  })
  const originalOn = smMock.on
  smMock.on = vi.fn((event: string, handler: Function) => {
    if (!handlers[event]) handlers[event] = []
    handlers[event].push(handler)
    // Also call original mock on() for SM event tracking
    if (originalOn?.getMockImplementation) originalOn(event, handler)
  })
  return smMock
}

/** Connect the XMPPClient and wait for it to become online */
async function connectClient(xmppClient: XMPPClient, mockInstance: MockXmppClient) {
  mockDiscoverWebSocket.mockResolvedValue(null)
  const connectPromise = xmppClient.connect({
    jid: 'user@example.com',
    password: 'pass',
    server: 'wss://example.com/ws',
  })
  await vi.advanceTimersByTimeAsync(100)
  mockInstance._emit('online')
  await vi.advanceTimersByTimeAsync(100)
  await connectPromise
}

describe('SM ack debouncing (patchSmAckDebounce)', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let mockXmppClientInstance: MockXmppClient
  let originalSendMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.useFakeTimers()
    mockStores = createMockStores()
    mockXmppClientInstance = createMockXmppClient()
    makeSmLikeReal(mockXmppClientInstance)

    // Save reference to original send mock before it gets wrapped
    originalSendMock = mockXmppClientInstance.send

    mockClientFactory._setInstance(mockXmppClientInstance)
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores as any)

    // Connect to trigger createXmppClient which applies the patches
    await connectClient(xmppClient, mockXmppClientInstance)
    // Clear xml mock calls from connection setup
    mockXmlFn.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('should debounce multiple SM ack sends within 250ms into one', async () => {
    // send() is now wrapped — the wrapper is the current mockXmppClientInstance.send
    const wrappedSend = mockXmppClientInstance.send

    // Simulate xmpp.js SM middleware sending acks for multiple <r/> requests
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '5' } } as any)
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '7' } } as any)
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '10' } } as any)

    // Before debounce fires, no ack should be sent via original send
    // xml() creates the fresh ack stanza — should not be called yet
    expect(mockXmlFn).not.toHaveBeenCalledWith('a', expect.objectContaining({ xmlns: 'urn:xmpp:sm:3' }))

    // Advance past debounce window (250ms)
    await vi.advanceTimersByTimeAsync(300)

    // Only ONE ack should have been constructed via xml()
    const ackCalls = mockXmlFn.mock.calls.filter(
      (call: any[]) => call[0] === 'a' && call[1]?.xmlns === 'urn:xmpp:sm:3'
    )
    expect(ackCalls).toHaveLength(1)
  })

  it('should use latest sm.inbound value when debounced ack fires', async () => {
    const wrappedSend = mockXmppClientInstance.send
    const smMock = mockXmppClientInstance.streamManagement as any

    // Set initial inbound count
    smMock.inbound = 5

    // xmpp.js SM middleware calls sendAck() which calls entity.send(<a h="5"/>)
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '5' } } as any)

    // More stanzas arrive, incrementing inbound before debounce fires
    smMock.inbound = 42

    // Advance past debounce window
    await vi.advanceTimersByTimeAsync(300)

    // The fresh ack should use h=42 (current sm.inbound), NOT h=5
    const ackCalls = mockXmlFn.mock.calls.filter(
      (call: any[]) => call[0] === 'a' && call[1]?.xmlns === 'urn:xmpp:sm:3'
    )
    expect(ackCalls).toHaveLength(1)
    expect((ackCalls[0] as any[])[1].h).toBe('42')
  })

  it('should pass through non-SM stanzas immediately without debouncing', async () => {
    const wrappedSend = mockXmppClientInstance.send

    // Send a regular presence stanza
    const presence = { name: 'presence', attrs: { type: 'available' }, children: [] }
    wrappedSend(presence as any)

    // The original send should be called immediately (no timer needed)
    expect(originalSendMock).toHaveBeenCalledWith(presence)
  })

  it('should reset debounce timer when new ack arrives within window', async () => {
    const wrappedSend = mockXmppClientInstance.send
    const smMock = mockXmppClientInstance.streamManagement as any

    smMock.inbound = 5
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '5' } } as any)

    // Advance 200ms (within 250ms window)
    await vi.advanceTimersByTimeAsync(200)

    // New ack arrives, resetting the timer
    smMock.inbound = 10
    wrappedSend({ name: 'a', attrs: { xmlns: 'urn:xmpp:sm:3', h: '10' } } as any)

    // At 200ms + 100ms = 300ms total, original 250ms timer would have fired
    // but it was reset — so no ack yet
    await vi.advanceTimersByTimeAsync(100)
    expect(mockXmlFn).not.toHaveBeenCalledWith('a', expect.objectContaining({ xmlns: 'urn:xmpp:sm:3' }))

    // Advance the remaining 150ms (200ms + 100ms + 150ms = 450ms)
    await vi.advanceTimersByTimeAsync(150)

    // Now the debounce should have fired
    const ackCalls = mockXmlFn.mock.calls.filter(
      (call: any[]) => call[0] === 'a' && call[1]?.xmlns === 'urn:xmpp:sm:3'
    )
    expect(ackCalls).toHaveLength(1)
    expect((ackCalls[0] as any[])[1].h).toBe('10')
  })
})

describe('SM ackQueue desync fix (patchSmAckQueue)', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let mockXmppClientInstance: MockXmppClient

  beforeEach(async () => {
    vi.useFakeTimers()
    mockStores = createMockStores()
    mockXmppClientInstance = createMockXmppClient()
    makeSmLikeReal(mockXmppClientInstance)

    mockClientFactory._setInstance(mockXmppClientInstance)
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores as any)

    await connectClient(xmppClient, mockXmppClientInstance)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('should not crash when outbound queue is empty (page reload scenario)', () => {
    const smMock = mockXmppClientInstance.streamManagement as any

    // Simulate page reload: queue is empty, outbound is 0
    smMock.outbound_q.length = 0
    smMock.outbound = 0

    // Simulate what ackQueue(50) does — server says h=50 but queue is empty
    // Without the patch, shift() returns undefined → crash on item.stanza
    expect(() => {
      const n = 50
      const oldOutbound = smMock.outbound
      for (let i = 0; i < +n - oldOutbound; i++) {
        const item = smMock.outbound_q.shift()
        smMock.outbound++
        // Access .stanza like ackQueue does — sentinel has .stanza = null
        smMock.emit('ack', item.stanza)
      }
    }).not.toThrow()

    // Outbound counter should be resynced to 50
    expect(smMock.outbound).toBe(50)
    expect(smMock.outbound_q.length).toBe(0)
  })

  it('should handle partial queue (some items, server h higher than queue)', () => {
    const smMock = mockXmppClientInstance.streamManagement as any

    // Queue has 2 items but server reports h=5
    smMock.outbound_q.push({ stanza: { name: 'message', attrs: { id: 'a' } } })
    smMock.outbound_q.push({ stanza: { name: 'message', attrs: { id: 'b' } } })
    smMock.outbound = 0

    // Simulate ackQueue(5) — processes 2 real items, then 3 sentinels
    const ackedStanzas: any[] = []
    const n = 5
    const oldOutbound = smMock.outbound
    for (let i = 0; i < +n - oldOutbound; i++) {
      const item = smMock.outbound_q.shift()
      smMock.outbound++
      if (item.stanza !== null) {
        ackedStanzas.push(item.stanza)
      }
      smMock.emit('ack', item.stanza)
    }

    // Should have acked the 2 real items
    expect(ackedStanzas).toHaveLength(2)
    expect(ackedStanzas[0].attrs.id).toBe('a')
    expect(ackedStanzas[1].attrs.id).toBe('b')
    // Outbound should be resynced to 5
    expect(smMock.outbound).toBe(5)
    expect(smMock.outbound_q.length).toBe(0)
  })

  it('should suppress ack events for sentinel items (stanza === null)', () => {
    const smMock = mockXmppClientInstance.streamManagement as any

    // The patched emit should suppress 'ack' events with null stanza
    const result = smMock.emit('ack', null)
    expect(result).toBe(false) // Suppressed — no handlers called
  })

  it('should re-patch queue when outbound_q is reassigned', () => {
    const smMock = mockXmppClientInstance.streamManagement as any

    // xmpp.js replaces outbound_q in resumed(): sm.outbound_q = []
    smMock.outbound_q = []
    smMock.outbound = 0

    // The new array should also have the patched shift()
    const item = smMock.outbound_q.shift()
    expect(item).toBeDefined()
    expect(item.stanza).toBeNull() // Sentinel
  })
})
