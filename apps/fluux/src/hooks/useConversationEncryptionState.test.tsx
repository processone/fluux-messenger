/**
 * State-machine unit tests for the composer's encryption-status hook.
 * The hook is the data half of the encryption chip — get it right and
 * the UI just renders from the returned state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useConversationEncryptionState } from './useConversationEncryptionState'

// Reach for the mocks the app-level test setup installs. `useChatStore` is
// already stubbed there, but `useConnection` / `useXMPPContext` /
// `useEncryptionSettingsStore` need per-test control, so we override here.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useConnection: vi.fn(),
    useXMPPContext: vi.fn(),
  }
})
vi.mock('@/stores/encryptionSettingsStore', () => ({
  useEncryptionSettingsStore: vi.fn(),
}))

import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const mockedUseConnection = useConnection as unknown as ReturnType<typeof vi.fn>
const mockedUseXMPPContext = useXMPPContext as unknown as ReturnType<typeof vi.fn>
const mockedUseEncryptionSettingsStore =
  useEncryptionSettingsStore as unknown as ReturnType<typeof vi.fn>

interface FakePlugin {
  getPeerFingerprint: ReturnType<typeof vi.fn>
  probePeer: ReturnType<typeof vi.fn>
}

function wireMocks(opts: {
  online?: boolean
  openpgpEnabled?: boolean
  plugin?: FakePlugin | null
}) {
  mockedUseConnection.mockReturnValue({ status: opts.online === false ? 'offline' : 'online' })
  mockedUseXMPPContext.mockReturnValue({
    client: {
      e2ee: opts.plugin === undefined
        ? null
        : {
            getPlugin: (id: string) => (id === 'openpgp' ? opts.plugin : null),
          },
    },
  })
  mockedUseEncryptionSettingsStore.mockImplementation((selector: (s: { openpgpEnabled: boolean }) => unknown) =>
    selector({ openpgpEnabled: opts.openpgpEnabled ?? true }),
  )
}

function makePlugin(overrides: Partial<FakePlugin> = {}): FakePlugin {
  return {
    getPeerFingerprint: vi.fn().mockReturnValue(null),
    probePeer: vi.fn().mockResolvedValue({ supported: false }),
    ...overrides,
  }
}

describe('useConversationEncryptionState', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("stays 'disabled' when the master toggle is off", () => {
    wireMocks({ openpgpEnabled: false, plugin: makePlugin() })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    expect(result.current).toEqual({ kind: 'disabled' })
  })

  it("stays 'disabled' for MUC conversations even with encryption enabled", () => {
    wireMocks({ plugin: makePlugin() })
    const { result } = renderHook(() =>
      useConversationEncryptionState('room@muc.example.com', 'groupchat'),
    )
    expect(result.current).toEqual({ kind: 'disabled' })
  })

  it("stays 'disabled' when offline", () => {
    wireMocks({ online: false, plugin: makePlugin() })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    expect(result.current).toEqual({ kind: 'disabled' })
  })

  it("stays 'disabled' when the plugin isn't registered yet", () => {
    // E2EE manager exists but no openpgp plugin yet — happens briefly
    // between the `online` event and registerE2EEPlugins completing.
    wireMocks({ plugin: null })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    expect(result.current).toEqual({ kind: 'disabled' })
  })

  it("returns 'encrypted' instantly when the peer key is already cached", () => {
    const plugin = makePlugin({
      getPeerFingerprint: vi.fn().mockReturnValue('ABCD1234'),
    })
    wireMocks({ plugin })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'ABCD1234' })
    // Fast path: no probe triggered.
    expect(plugin.probePeer).not.toHaveBeenCalled()
  })

  it("goes through 'checking' then 'encrypted' on a successful probe", async () => {
    // First lookup: cache miss. After probe: cache hit.
    const fp = 'EEFF00001111'
    let cacheHit = false
    const plugin = makePlugin({
      getPeerFingerprint: vi.fn().mockImplementation(() => (cacheHit ? fp : null)),
      probePeer: vi.fn().mockImplementation(async () => {
        cacheHit = true
        return { supported: true }
      }),
    })
    wireMocks({ plugin })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    // Synchronously in 'checking' state while probe is in flight.
    expect(result.current.kind).toBe('checking')
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'encrypted', fingerprint: fp })
    })
    expect(plugin.probePeer).toHaveBeenCalledWith('bob@example.com')
  })

  it("falls to 'unsupported' when the probe returns supported=false", async () => {
    const plugin = makePlugin({
      probePeer: vi.fn().mockResolvedValue({ supported: false }),
    })
    wireMocks({ plugin })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'unsupported' })
    })
  })

  it("treats probe exceptions as 'unsupported' rather than crashing", async () => {
    const plugin = makePlugin({
      probePeer: vi.fn().mockRejectedValue(new Error('server glitch')),
    })
    wireMocks({ plugin })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => {
      expect(result.current).toEqual({ kind: 'unsupported' })
    })
  })

  it('cancels a pending probe if the conversation changes before it resolves', async () => {
    // Slow probe on the first peer. Before it resolves, we switch the
    // hook to a new peer whose key is already cached. The switched-to
    // state must stick; the first probe's resolution must NOT bounce
    // the UI back to unsupported/encrypted for alice.
    let resolveAliceProbe: (v: { supported: boolean }) => void = () => {}
    const plugin = makePlugin({
      getPeerFingerprint: vi.fn().mockImplementation((peer: string) =>
        peer === 'bob@example.com' ? 'BOBFP' : null,
      ),
      probePeer: vi.fn().mockImplementation((peer: string) => {
        if (peer === 'alice@example.com') {
          return new Promise((resolve) => {
            resolveAliceProbe = resolve
          })
        }
        return Promise.resolve({ supported: true })
      }),
    })
    wireMocks({ plugin })
    const { result, rerender } = renderHook(
      (peer: string) => useConversationEncryptionState(peer, 'chat'),
      { initialProps: 'alice@example.com' },
    )
    // Probing alice…
    expect(result.current.kind).toBe('checking')

    // Switch to bob — immediate cache hit.
    rerender('bob@example.com')
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'BOBFP' })

    // Now let the stale alice probe resolve. The hook's cancellation
    // flag must prevent this from overwriting the bob state.
    await act(async () => {
      resolveAliceProbe({ supported: true })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'BOBFP' })
  })
})
