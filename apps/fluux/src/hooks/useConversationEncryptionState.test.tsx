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
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'unverified' })
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
      expect(result.current).toEqual({ kind: 'encrypted', fingerprint: fp, trust: 'unverified' })
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
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'BOBFP', trust: 'unverified' })

    // Now let the stale alice probe resolve. The hook's cancellation
    // flag must prevent this from overwriting the bob state.
    await act(async () => {
      resolveAliceProbe({ supported: true })
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current).toEqual({ kind: 'encrypted', fingerprint: 'BOBFP', trust: 'unverified' })
  })

  describe('verification trust derivation', () => {
    // Use the real verification store rather than re-mocking. The
    // assertions below depend on the JID + fingerprint pair pinning,
    // which is the whole point — mocking the store would let a bug
    // in that pinning logic slip past.
    const mod = '@/stores/verifiedPeerKeysStore'
    type VerifiedStore = typeof import('@/stores/verifiedPeerKeysStore')
    let store: VerifiedStore
    beforeEach(async () => {
      localStorage.clear()
      store = (await import(mod)) as VerifiedStore
      store.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })
    afterEach(() => {
      store.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })

    it("returns trust='verified' when the cached fingerprint is in the store", () => {
      store.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', 'CAFE1234')
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue('CAFE1234'),
      })
      wireMocks({ plugin })
      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      expect(result.current).toEqual({
        kind: 'encrypted',
        fingerprint: 'CAFE1234',
        trust: 'verified',
      })
    })

    it("auto-demotes to 'unverified' when the cached fingerprint differs from the verified one", () => {
      // Pin to the OLD fingerprint, but the cache returns a NEW one —
      // simulates a key rotation that hasn't been re-confirmed. The
      // chip must drop back to BTBV trust until the user re-verifies.
      store.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', 'OLD_FP_VALUE')
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue('NEW_FP_VALUE'),
      })
      wireMocks({ plugin })
      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      expect(result.current).toEqual({
        kind: 'encrypted',
        fingerprint: 'NEW_FP_VALUE',
        trust: 'unverified',
      })
    })

    it('flips to verified when the user verifies mid-render (store update reflows the hook)', () => {
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue('FP'),
      })
      wireMocks({ plugin })
      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      // Pre-verify state.
      expect(result.current).toMatchObject({ trust: 'unverified' })
      // User confirms the fingerprint via the dialog — the hook's
      // verifiedFingerprint subscription should pick the change up
      // without needing a remount.
      act(() => {
        store.useVerifiedPeerKeysStore.getState().setVerified('bob@example.com', 'FP')
      })
      expect(result.current).toMatchObject({ trust: 'verified' })
    })
  })

  // ---------------------------------------------------------------------------
  // Reconnect fast-path tests
  //
  // After a reconnect the plugin cache is cold (getPeerFingerprint → null).
  // For a peer the user has already verified the hook must return 'encrypted'
  // immediately from the persisted fingerprint — no 'checking' flash — and
  // fire a background probe to warm the plugin cache.
  // ---------------------------------------------------------------------------
  // ---------------------------------------------------------------------------
  // Forced-plaintext override tests
  //
  // When the user has explicitly disabled encryption for a conversation, the
  // hook must return `plaintextForced` regardless of what the plugin cache or
  // probe reports — including when the peer has a verified fingerprint.
  // ---------------------------------------------------------------------------
  describe('forced-plaintext override', () => {
    const overrideMod = '@/stores/conversationPlaintextOverrideStore'
    type OverrideStore = typeof import('@/stores/conversationPlaintextOverrideStore')
    let overrideStore: OverrideStore

    beforeEach(async () => {
      localStorage.clear()
      overrideStore = (await import(overrideMod)) as OverrideStore
      overrideStore.useConversationPlaintextOverrideStore.setState({ plaintextJids: {} })
    })

    afterEach(() => {
      overrideStore.useConversationPlaintextOverrideStore.setState({ plaintextJids: {} })
    })

    it("returns 'plaintextForced' when the override store has the peer JID", () => {
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue(null),
        probePeer: vi.fn().mockResolvedValue({ supported: false }),
      })
      wireMocks({ plugin })

      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', true)
      })

      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      expect(result.current).toEqual({ kind: 'plaintextForced' })
    })

    it("returns 'plaintextForced' even when the plugin cache has a fingerprint", () => {
      // Override takes precedence over the cached key — memo is authoritative.
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue('ABCD1234'),
      })
      wireMocks({ plugin })

      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', true)
      })

      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      expect(result.current).toEqual({ kind: 'plaintextForced' })
    })

    it('does not trigger a probe when forced plaintext (effect short-circuits)', async () => {
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue(null),
        probePeer: vi.fn().mockResolvedValue({ supported: true }),
      })
      wireMocks({ plugin })

      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', true)
      })

      renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))

      // Flush microtasks to confirm no probe was triggered.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(plugin.probePeer).not.toHaveBeenCalled()
    })

    it('returns to normal probe behavior once the override is removed', async () => {
      const fp = 'CAFE5678'
      let cacheHit = false
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockImplementation(() => (cacheHit ? fp : null)),
        probePeer: vi.fn().mockImplementation(async () => {
          cacheHit = true
          return { supported: true }
        }),
      })
      wireMocks({ plugin })

      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', true)
      })

      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )
      expect(result.current).toEqual({ kind: 'plaintextForced' })

      // User re-enables encryption.
      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', false)
      })

      // Hook transitions back through 'checking' then 'encrypted'.
      await waitFor(() => {
        expect(result.current).toEqual({ kind: 'encrypted', fingerprint: fp, trust: 'unverified' })
      })
    })

    it("'plaintextForced' applies only to the targeted JID, not to other peers", () => {
      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockImplementation((peer: string) =>
          peer === 'alice@example.com' ? 'ALICE_FP' : null,
        ),
      })
      wireMocks({ plugin })

      act(() => {
        overrideStore.useConversationPlaintextOverrideStore
          .getState()
          .setForcedPlaintext('bob@example.com', true)
      })

      const { result: aliceResult } = renderHook(() =>
        useConversationEncryptionState('alice@example.com', 'chat'),
      )
      expect(aliceResult.current).toEqual({
        kind: 'encrypted',
        fingerprint: 'ALICE_FP',
        trust: 'unverified',
      })
    })
  })

  describe('reconnect fast path for verified peers', () => {
    const mod = '@/stores/verifiedPeerKeysStore'
    type VerifiedStore = typeof import('@/stores/verifiedPeerKeysStore')
    let store: VerifiedStore

    beforeEach(async () => {
      localStorage.clear()
      store = (await import(mod)) as VerifiedStore
      store.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })

    afterEach(() => {
      store.useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
    })

    it("returns 'encrypted' immediately from the stored fingerprint when plugin cache is cold", () => {
      // Peer has a verified fingerprint persisted from a previous session, but
      // the plugin cache is empty (simulates cold start or post-reconnect state).
      store.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', 'STORED_FP')

      const plugin = makePlugin({
        // Cache miss — plugin hasn't seen this peer yet this session.
        getPeerFingerprint: vi.fn().mockReturnValue(null),
        // Probe resolves eventually but the hook must NOT wait for it.
        probePeer: vi.fn().mockResolvedValue({ supported: true }),
      })
      wireMocks({ plugin })

      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )

      // Must be synchronously 'encrypted' — no 'checking' flash.
      expect(result.current).toEqual({
        kind: 'encrypted',
        fingerprint: 'STORED_FP',
        trust: 'verified',
      })
    })

    it('fires a background probe to warm the plugin cache even when fast-path applies', async () => {
      store.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', 'STORED_FP')

      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue(null),
        probePeer: vi.fn().mockResolvedValue({ supported: true }),
      })
      wireMocks({ plugin })

      renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))

      // Flush the background microtask queue.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      expect(plugin.probePeer).toHaveBeenCalledWith('bob@example.com')
    })

    it('keeps showing encrypted when the background probe fails (transient error)', async () => {
      store.useVerifiedPeerKeysStore
        .getState()
        .setVerified('bob@example.com', 'STORED_FP')

      const plugin = makePlugin({
        getPeerFingerprint: vi.fn().mockReturnValue(null),
        // Network hiccup — probe throws.
        probePeer: vi.fn().mockRejectedValue(new Error('timeout')),
      })
      wireMocks({ plugin })

      const { result } = renderHook(() =>
        useConversationEncryptionState('bob@example.com', 'chat'),
      )

      // Flush the rejected promise.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })

      // Must NOT fall to 'unsupported' — the stored fingerprint is authoritative.
      expect(result.current).toEqual({
        kind: 'encrypted',
        fingerprint: 'STORED_FP',
        trust: 'verified',
      })
    })

    it("goes through 'checking' normally for an unverified peer with cold cache", async () => {
      // No verified fingerprint stored → should behave as before: 'checking'
      // then 'encrypted' after the probe resolves.
      const fp = 'FRESH_FP'
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

      // No stored fingerprint → should show 'checking' while probe runs.
      expect(result.current.kind).toBe('checking')

      await waitFor(() => {
        expect(result.current).toEqual({
          kind: 'encrypted',
          fingerprint: fp,
          trust: 'unverified',
        })
      })
    })
  })
})
