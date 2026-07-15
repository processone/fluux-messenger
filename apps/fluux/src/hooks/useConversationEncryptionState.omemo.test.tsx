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
    useConnection: vi.fn(),
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

import { useConnection, useConnectionStatus, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useWebKeyLocked } from '@/hooks/useWebKeyLocked'

const mockedUseConnection = useConnection as unknown as ReturnType<typeof vi.fn>
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
}) {
  const conn = { status: opts.online === false ? 'offline' : 'online' }
  mockedUseConnection.mockReturnValue(conn)
  mockedUseConnectionStatus.mockReturnValue(conn)
  const omemoPlugin = opts.omemoPlugin
  mockedUseXMPPContext.mockReturnValue({
    client: {
      e2ee: {
        getPlugin: (id: string) => (id === 'omemo:2' ? omemoPlugin : null),
        selectStrategy: vi.fn(async () => omemoPlugin ?? null),
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

  it("reports 'encrypted' with omemoTrust when OMEMO is the selected strategy (tofu)", async () => {
    wireMocks({ omemoPlugin: makeOmemoPlugin('tofu') })
    const { result } = renderHook(() =>
      useConversationEncryptionState('bob@example.com', 'chat'),
    )
    await waitFor(() => expect(result.current.kind).toBe('encrypted'))
    expect(result.current).toEqual({
      kind: 'encrypted',
      protocolId: 'omemo:2',
      fingerprint: '',
      trust: 'tofu-new',
      omemoTrust: 'tofu',
    })
  })

  it("maps OMEMO 'verified' trust to trust='verified'", async () => {
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
      omemoTrust: 'verified',
    })
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
})
