import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ConnectionStatus } from '@fluux/sdk'
import { useSessionPersistence } from './useSessionPersistence'

// The Tauri "retry with the keychain password on auth error" effect
// (useSessionPersistence) is a one-shot per failure episode. Regression #995:
// with a genuinely wrong stored password it looped forever, because its own
// retry connect() flips status through the transient 'connecting' state, which
// used to re-arm the one-shot. These tests drive the exact status sequence a
// retry produces and assert the retry fires at most once.

// A mutable status holder the mocked useConnectionStore reads on every render,
// so tests can replay the error → connecting → error cycle via rerender().
// Named `mock*` so vitest allows referencing it inside a hoisted vi.mock factory.
const mockStatusHolder = { value: 'error' as ConnectionStatus }
function setStatus(next: ConnectionStatus): void {
  mockStatusHolder.value = next
}

// Spy for the SDK connect action the retry effect invokes.
const mockConnect = vi.fn().mockResolvedValue(undefined)

const JID = 'user@example.com'
const SERVER = 'example.com'

// Force the Tauri code path and a present-but-wrong stored credential.
// JID/server are inlined here: vi.mock factories are hoisted above module
// consts, so they cannot reference JID/SERVER.
vi.mock('@/utils/tauri', () => ({
  isTauri: () => true,
}))
vi.mock('@/utils/keychain', () => ({
  hasSavedCredentials: () => true,
  getCredentials: vi.fn().mockResolvedValue({ jid: 'user@example.com', password: 'stale-password', server: 'example.com' }),
}))

// Override the SDK mock so connect() is our spy and the status the hook reads
// comes from statusHolder. Real JID utilities are preserved so the retry's
// bare-JID match against the saved JID behaves like production.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnectionActions: () => ({ connect: mockConnect }),
    useXMPPContext: () => ({ client: { profile: { restoreOwnAvatarFromCache: vi.fn() } } }),
    connectionStore: {
      getState: () => ({ jid: null, setStatus: vi.fn(), setError: vi.fn() }),
      subscribe: vi.fn(() => vi.fn()),
    },
  }
})

// React-bound stores: useConnectionStore returns the current holder status.
vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = {
      status: mockStatusHolder.value,
      setServerInfo: vi.fn(),
      setHttpUploadService: vi.fn(),
      setOwnNickname: vi.fn(),
      updateOwnResource: vi.fn(),
    }
    return selector ? selector(state) : state
  }),
  useRosterStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { setContacts: vi.fn() }
    return selector ? selector(state) : state
  }),
  useRoomStore: vi.fn((selector?: (s: Record<string, unknown>) => unknown) => {
    const state = { addRoom: vi.fn() }
    return selector ? selector(state) : state
  }),
}))

async function flush(): Promise<void> {
  // Let the retry effect's async getCredentials()/connect() microtasks settle.
  await Promise.resolve()
  await Promise.resolve()
}

describe('useSessionPersistence — keychain retry one-shot (issue #995)', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    mockConnect.mockClear()
    setStatus('error')
    // savedJid is required for the retry effect to arm.
    localStorage.setItem('xmpp-last-jid', JID)
    localStorage.setItem('xmpp-last-server', SERVER)
  })

  // Positive control: proves the effect actually fires a retry, so the
  // "called once" assertion below is meaningful (the guard, not dead wiring).
  it('retries with the keychain password once when status is error', async () => {
    renderHook(() => useSessionPersistence())
    await flush()

    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  // ★ The core regression guard for the infinite loop.
  it('does NOT re-retry across the retry-induced error → connecting → error cycle', async () => {
    const { rerender } = renderHook(() => useSessionPersistence())
    await flush()
    expect(mockConnect).toHaveBeenCalledTimes(1)

    // The retry's own connect() drives status error → connecting → error in
    // production. Replay that cycle several times; the one-shot must not re-arm
    // on the transient 'connecting' state.
    for (let i = 0; i < 3; i++) {
      setStatus('connecting'); rerender(); await flush()
      setStatus('error'); rerender(); await flush()
    }

    expect(mockConnect).toHaveBeenCalledTimes(1)
  })

  // The one-shot re-arms after a genuinely new episode: a successful login
  // (status 'online') followed by a later auth error retries once more.
  it('re-arms the keychain retry after a successful login', async () => {
    const { rerender } = renderHook(() => useSessionPersistence())
    await flush()
    expect(mockConnect).toHaveBeenCalledTimes(1)

    setStatus('online'); rerender(); await flush()
    setStatus('error'); rerender(); await flush()

    expect(mockConnect).toHaveBeenCalledTimes(2)
  })
})
