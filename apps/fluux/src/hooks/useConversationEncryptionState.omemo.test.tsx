/**
 * OMEMO-selection tests for the composer's encryption-status hook.
 *
 * These exercise the isolated OMEMO effect: when `selectStrategy` picks
 * the `omemo:2` plugin for a 1:1 peer, the hook must report `encrypted`
 * with the peer's aggregate OMEMO trust (and an empty fingerprint, since
 * per-device fingerprint surfacing is a later slice). The OpenPGP path is
 * covered by the sibling `.test.tsx` and is not re-tested here.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useConversationEncryptionState } from './useConversationEncryptionState'

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    useConnectionStatus: vi.fn(),
    useXMPPContext: vi.fn(),
  }
})
vi.mock('@/stores/encryptionSettingsStore', () => ({
  useEncryptionSettingsStore: vi.fn(),
}))
vi.mock('@/hooks/useWebKeyLocked', () => ({
  useWebKeyLocked: vi.fn(() => false),
}))

import { useConnectionStatus, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'

const mockedUseConnectionStatus = useConnectionStatus as unknown as ReturnType<typeof vi.fn>
const mockedUseXMPPContext = useXMPPContext as unknown as ReturnType<typeof vi.fn>
const mockedUseEncryptionSettingsStore =
  useEncryptionSettingsStore as unknown as ReturnType<typeof vi.fn>
const mockedUseWebKeyLocked = useWebKeyLocked as unknown as ReturnType<typeof vi.fn>

interface OmemoPlugin {
  descriptor: { id: string; securityLevel: number }
  getPeerTrust: ReturnType<typeof vi.fn>
}

function makeOmemoPlugin(trust: string = 'tofu'): OmemoPlugin {
  return {
    descriptor: { id: 'omemo:2', securityLevel: 80 },
    getPeerTrust: vi.fn().mockResolvedValue(trust),
  }
}

function wireMocks(opts: {
  online?: boolean
  openpgpEnabled?: boolean
  omemoEnabled?: boolean
  omemoPlugin?: OmemoPlugin | null
  /** Override the plugin resolved by selectStrategy (defaults to omemoPlugin). */
  selectStrategyPlugin?: OmemoPlugin | null
  /** Optional custom selectStrategy impl, e.g. to delay resolution. */
  selectStrategyImpl?: (req: { kind: 'direct'; peer: string }) => Promise<OmemoPlugin | null>
}) {
  const conn = { status: opts.online === false ? 'offline' : 'online' }
  mockedUseConnectionStatus.mockReturnValue(conn)
  const omemoPlugin = opts.omemoPlugin
  const resolvedPlugin = 'selectStrategyPlugin' in opts ? opts.selectStrategyPlugin : omemoPlugin
  mockedUseXMPPContext.mockReturnValue({
    client: {
      e2ee: {
        getPlugin: (id: string) => (id === 'omemo:2' ? omemoPlugin : null),
        selectStrategy: opts.selectStrategyImpl ?? vi.fn(async () => resolvedPlugin ?? null),
      },
    },
  })
  mockedUseEncryptionSettingsStore.mockImplementation(
    (selector: (s: { openpgpEnabled: boolean; omemoEnabled: boolean }) => unknown) =>
      selector({
        openpgpEnabled: opts.openpgpEnabled ?? false,
        omemoEnabled: opts.omemoEnabled ?? true,
      }),
  )
}

describe('useConversationEncryptionState — OMEMO selection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockedUseWebKeyLocked.mockReturnValue(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("reports 'encrypted' with TrustState passed through when OMEMO is selected (tofu)", async () => {
    wireMocks({ omemoPlugin: makeOmemoPlugin('tofu') })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'tofu',
    })
  })

  it("passes OMEMO 'verified' trust through unchanged", async () => {
    wireMocks({ omemoPlugin: makeOmemoPlugin('verified') })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'verified',
    })
  })

  it('clears the previous peer\'s OMEMO result synchronously on peer switch (no stale-trust flash)', async () => {
    // Regression test: the OMEMO selection effect must reset `omemoResult`
    // to null BEFORE kicking off the async `selectStrategy` call, so that
    // switching from a peer that resolved to omemo:2/verified to a new
    // peer never briefly surfaces the OLD peer's encrypted/trust state
    // while the new peer's selection is still in flight.
    const pluginA = makeOmemoPlugin('verified')
    let resolveB: (value: OmemoPlugin | null) => void = () => {}
    const bResult = new Promise<OmemoPlugin | null>((resolve) => {
      resolveB = resolve
    })

    wireMocks({
      omemoPlugin: pluginA,
      selectStrategyImpl: vi.fn(async (req: { peer: string }) => {
        if (req.peer === 'alice@example.com') return pluginA
        return bResult
      }),
    })

    const { result, rerender } = renderHook(
      ({ peer }: { peer: string }) => useConversationEncryptionState(peer, 'chat'),
      { initialProps: { peer: 'alice@example.com' } },
    )

    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'verified',
    })

    // Switch to a different peer whose selectStrategy is still pending
    // (bResult hasn't resolved yet).
    rerender({ peer: 'bob@example.com' })

    // Immediately after the peer switch — before bob's selectStrategy
    // resolves — the hook must NOT still report alice's omemo:2/verified
    // result. The synchronous reset in the effect should have already
    // cleared it, falling through to the OpenPGP/checking/disabled path.
    expect(result.current).not.toEqual(
      expect.objectContaining({ protocolId: 'omemo:2', trust: 'verified' }),
    )
    expect(result.current.kind).not.toBe('encrypted')

    // Resolve bob's selection as "no OMEMO" so the effect settles cleanly.
    resolveB(null)
    await waitFor(() => expect(result.current.kind).not.toBe('encrypted'))
  })

  it('does not report an OMEMO encrypted state when selectStrategy returns null', async () => {
    // Peer supports neither protocol → selectStrategy resolves null.
    // The OMEMO effect must leave omemoResult null so the hook falls
    // through to the OpenPGP/unsupported/disabled path (never surfacing
    // a phantom omemo:2 encrypted state).
    wireMocks({ omemoPlugin: null })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    // Give the async selection a chance to resolve.
    await waitFor(() =>
      expect(mockedUseXMPPContext).toHaveBeenCalled(),
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(result.current).not.toEqual(
      expect.objectContaining({ kind: 'encrypted', protocolId: 'omemo:2' }),
    )
  })

  it("reports 'needsDeviceVerification' when OMEMO peer has devices but all are untrusted", async () => {
    const plugin = makeOmemoPlugin('untrusted')
    ;(plugin as unknown as { listPeerIdentities: ReturnType<typeof vi.fn> }).listPeerIdentities = vi
      .fn()
      .mockResolvedValue([
        { id: '1', fingerprint: 'aa', trust: 'untrusted' },
        { id: '2', fingerprint: 'bb', trust: 'untrusted' },
      ])
    wireMocks({ omemoPlugin: plugin })
    const { result } = renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))
    await waitFor(() => expect(result.current.kind).toBe('needsDeviceVerification'))
    expect(result.current).toEqual({ kind: 'needsDeviceVerification', peerJid: 'bob@example.com' })
  })

  it('stays encrypted when at least one device is trusted', async () => {
    const plugin = makeOmemoPlugin('tofu')
    ;(plugin as unknown as { listPeerIdentities: ReturnType<typeof vi.fn> }).listPeerIdentities = vi
      .fn()
      .mockResolvedValue([
        { id: '1', fingerprint: 'aa', trust: 'untrusted' },
        { id: '2', fingerprint: 'bb', trust: 'tofu' },
      ])
    wireMocks({ omemoPlugin: plugin })
    const { result } = renderHook(() => useConversationEncryptionState('bob@example.com', 'chat'))
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
  })
})
