/**
 * Tests for FAST token invalidation (XEP-0484 §6).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── Mocks for @xmpp/client ──
// A fresh mock xmpp.js client is produced per test. We emulate the FAST
// module's `auth` method, which our code wraps to inject invalidate='true'
// on the <fast/> element inside the outgoing <authenticate/>.
interface MockFastAuthArgs {
  authenticate: (innerArgs: unknown) => Promise<void>
  streamFeatures: unknown[]
  credentials: unknown
}

interface MockXmppInstance {
  on: (event: string, handler: (...args: unknown[]) => void) => MockXmppInstance
  start: () => Promise<void>
  stop: () => Promise<void>
  fast: {
    fetchToken: () => Promise<unknown>
    saveToken: (t: unknown) => void
    deleteToken: () => void
    auth: (args: MockFastAuthArgs) => Promise<boolean>
  }
  _emit: (event: string, ...args: unknown[]) => void
  _runAuth: () => Promise<void>
  _capturedFastElement: { name: string; attrs: Record<string, string> } | null
  _capturedInnerArgs: unknown
  _startCalled: boolean
  _stopCalled: boolean
}

const createMockInstance = (): MockXmppInstance => {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  // The fast element that will be emitted during auth. The real xmpp.js FAST
  // module builds this via ltx's xml() inside its auth() method; we pre-build
  // it here so the test can observe whether our patch set invalidate='true'.
  const fastElement = { name: 'fast', attrs: { xmlns: 'urn:xmpp:fast:0' } }

  const inst: MockXmppInstance = {
    on: (event, handler) => {
      handlers[event] = handlers[event] || []
      handlers[event].push(handler)
      return inst
    },
    start: vi.fn(async () => {
      inst._startCalled = true
    }),
    stop: vi.fn(async () => {
      inst._stopCalled = true
    }),
    fast: {
      fetchToken: async () => null,
      saveToken: () => {},
      deleteToken: () => {},
      // Emulate fast.auth: build streamFeatures with the <fast/> element,
      // then call args.authenticate (which our patch wraps).
      auth: async (args: MockFastAuthArgs) => {
        const innerArgs = {
          ...args,
          streamFeatures: [...(args.streamFeatures ?? []), fastElement],
        }
        await args.authenticate(innerArgs)
        return true
      },
    },
    _emit: (event, ...args) => {
      for (const h of handlers[event] ?? []) h(...args)
    },
    // Simulate sasl2 calling fast.auth with a no-op authenticate so the
    // patch's inner wrapper runs and mutates the <fast/> attributes.
    _runAuth: async () => {
      await inst.fast.auth({
        authenticate: async (innerArgs: unknown) => {
          inst._capturedInnerArgs = innerArgs
        },
        streamFeatures: [],
        credentials: {},
      })
    },
    _capturedFastElement: fastElement,
    _capturedInnerArgs: null,
    _startCalled: false,
    _stopCalled: false,
  }
  return inst
}

const { mockClientFactory, mockInstances } = vi.hoisted(() => {
  const instances: MockXmppInstance[] = []
  const factory = vi.fn()
  return { mockClientFactory: factory, mockInstances: instances }
})

vi.mock('@xmpp/client', () => ({
  client: mockClientFactory,
}))

vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

// ── Mocks for fastTokenStorage ──
const { mockFetchFastToken } = vi.hoisted(() => ({
  mockFetchFastToken: vi.fn(),
}))

vi.mock('./fastTokenStorage', () => ({
  fetchFastToken: mockFetchFastToken,
  saveFastToken: vi.fn(),
  deleteFastToken: vi.fn(),
  hasFastToken: vi.fn(),
}))

// Quiet logger
vi.mock('./logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
}))

import { invalidateFastTokenOnServer } from './fastTokenInvalidation'

const TOKEN = {
  mechanism: 'HT-SHA-256-NONE',
  token: 'opaque-token-abc',
  expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
}

describe('invalidateFastTokenOnServer', () => {
  beforeEach(() => {
    mockClientFactory.mockReset()
    mockFetchFastToken.mockReset()
    mockInstances.length = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns {ok:false, no-token} when no stored token exists', async () => {
    mockFetchFastToken.mockReturnValue(null)
    const result = await invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    expect(result).toEqual({ ok: false, reason: 'no-token' })
    expect(mockClientFactory).not.toHaveBeenCalled()
  })

  it('uses a pre-fetched token without reading localStorage', async () => {
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
      token: TOKEN,
    })
    await Promise.resolve()
    inst._emit('online')
    const result = await p

    expect(result.ok).toBe(true)
    // The caller already deleted the local copy; we must not depend on it.
    expect(mockFetchFastToken).not.toHaveBeenCalled()
  })

  it('returns {ok:false, invalid-jid} when JID lacks a localpart', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const result = await invalidateFastTokenOnServer({
      jid: 'example.com',
      server: 'wss://example.com/ws',
    })
    expect(result).toEqual({ ok: false, reason: 'invalid-jid' })
    expect(mockClientFactory).not.toHaveBeenCalled()
  })

  it('accepts a bare host for `server` and derives the WebSocket URL', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'example.com',
    })
    // Give microtasks a turn so the client handlers attach, then signal success
    await Promise.resolve()
    inst._emit('online')
    const result = await p

    expect(result.ok).toBe(true)
    const arg = mockClientFactory.mock.calls[0][0] as { service: string }
    expect(arg.service).toBe('wss://example.com/ws')
  })

  it('resolves {ok:true} when the xmpp.js client emits online', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    await Promise.resolve()
    inst._emit('online')

    const result = await p
    expect(result).toEqual({ ok: true })
    expect(inst._stopCalled).toBe(true)
  })

  it('sets invalidate="true" on the <fast/> element during auth', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    // Let the helper set up listeners and monkey-patch fast.auth
    await Promise.resolve()
    // Drive the fast.auth flow as sasl2 would
    await inst._runAuth()
    inst._emit('online')
    await p

    // Our patch should have mutated the <fast/> element
    expect(inst._capturedFastElement?.attrs.invalidate).toBe('true')
    // And the wrapped authenticate should have been invoked with the mutated features
    const innerArgs = inst._capturedInnerArgs as { streamFeatures: unknown[] }
    const fastEl = (innerArgs.streamFeatures as Array<{ name: string; attrs: Record<string, string> }>)
      .find((el) => el.name === 'fast')
    expect(fastEl?.attrs.invalidate).toBe('true')
  })

  it('overrides fetchToken to return the in-memory token', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    await Promise.resolve()
    const fetched = await inst.fast.fetchToken()
    inst._emit('online')
    await p

    expect(fetched).toEqual(TOKEN)
  })

  it('treats not-authorized as already-invalid (ok:true)', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    await Promise.resolve()
    inst._emit('error', { condition: 'not-authorized', message: 'token rejected' })

    const result = await p
    expect(result.ok).toBe(true)
    expect(result.reason).toBe('already-invalid')
  })

  it('resolves {ok:false} with the error message on unrelated errors', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    await Promise.resolve()
    inst._emit('error', new Error('socket closed'))

    const result = await p
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('socket closed')
  })

  it('times out with {ok:false, timeout} when no event fires', async () => {
    vi.useFakeTimers()
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
      timeoutMs: 100,
    })
    await vi.advanceTimersByTimeAsync(150)

    const result = await p
    expect(result).toEqual({ ok: false, reason: 'timeout' })
    expect(inst._stopCalled).toBe(true)
  })

  it('resolves {ok:false} when start() rejects', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    inst.start = vi.fn().mockRejectedValue(new Error('DNS failure'))
    mockClientFactory.mockImplementation(() => inst)

    const result = await invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('DNS failure')
  })

  it('does not resolve twice when multiple events fire', async () => {
    mockFetchFastToken.mockReturnValue(TOKEN)
    const inst = createMockInstance()
    mockClientFactory.mockImplementation(() => inst)

    const p = invalidateFastTokenOnServer({
      jid: 'alice@example.com',
      server: 'wss://example.com/ws',
    })
    await Promise.resolve()
    inst._emit('online')
    inst._emit('error', new Error('spurious later error'))

    const result = await p
    expect(result.ok).toBe(true)
    // stop should only fire once from the online path
    expect((inst.stop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
  })
})
