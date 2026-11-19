/**
 * The overview's OpenPGP row as the mounted hook reports it (FLM-294 spec): warnings known locally show at once,
 * the own-key conflict and compromised-trust warnings count, a locked key reads Locked, and an unlock or recovery
 * that finishes elsewhere updates the row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useOpenPgpOverviewState } from './openPgpOverviewState'

const FP = 'ab'.repeat(20)
let plugin: Record<string, unknown>
let webLocked = false
let conflict: unknown = null
let verdict = { status: 'ok' }
let unlockListener: (() => void) | null = null
let platformFlags = { nativeOpenpgp: false }
const checkPepSupport = vi.fn()

// One client for every render, as the real context provides.
const client = {
  e2ee: { getPlugin: () => plugin },
  server: { checkPepSupport },
  subscribe: (_event: string, cb: () => void) => {
    unlockListener = cb
    return () => {
      unlockListener = null
    }
  },
}
vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({ status: 'online' }),
  useXMPPContext: () => ({ client }),
}))
vi.mock('@/hooks/useWebKeyLocked', () => ({ useWebKeyLocked: () => webLocked }))
vi.mock('@/e2ee/openpgpTrustView', () => ({
  useOwnKeyConflict: () => conflict,
  useTrustStateVerdict: () => verdict,
}))
vi.mock('@/platform', () => ({ platform: () => platformFlags }))

const pending = <T,>() => new Promise<T>(() => {})

beforeEach(() => {
  webLocked = false
  conflict = null
  verdict = { status: 'ok' }
  unlockListener = null
  platformFlags = { nativeOpenpgp: false }
  checkPepSupport.mockReset().mockResolvedValue(true)
  plugin = {
    getOwnFingerprint: () => FP,
    getBackedUpFingerprint: () => FP,
    probeSecretKeyBackup: () => Promise.resolve('present'),
    isKeychainBacked: () => true,
    isKeyRecoveryNeeded: () => false,
  }
  useEncryptionSettingsStore.setState({ openpgpEnabled: true, registrationError: null, pluginRegisteredAt: 1 })
})

describe('useOpenPgpOverviewState', () => {
  it('reads On with its backup state once the server answers', async () => {
    const { result } = renderHook(() => useOpenPgpOverviewState())
    expect(result.current).toBe('on')
    await waitFor(() => expect(result.current).toBe('on-backed-up'))
  })

  it('shows a warning known locally while the server requests are still pending', () => {
    platformFlags = { nativeOpenpgp: true }
    plugin.isKeychainBacked = () => false
    checkPepSupport.mockReturnValue(pending())
    plugin.probeSecretKeyBackup = () => pending()
    const { result } = renderHook(() => useOpenPgpOverviewState())
    expect(result.current).toBe('needs-attention')
  })

  it('needs attention when the server has no PEP', async () => {
    checkPepSupport.mockResolvedValue(false)
    const { result } = renderHook(() => useOpenPgpOverviewState())
    await waitFor(() => expect(result.current).toBe('needs-attention'))
  })

  it('needs attention for an own-key conflict and for compromised trust data', async () => {
    conflict = { kind: 'primary-mismatch' }
    const first = renderHook(() => useOpenPgpOverviewState())
    await waitFor(() => expect(first.result.current).toBe('needs-attention'))
    conflict = null
    verdict = { status: 'compromised' }
    const second = renderHook(() => useOpenPgpOverviewState())
    await waitFor(() => expect(second.result.current).toBe('needs-attention'))
  })

  it('reads Locked while the web key waits for its passphrase', () => {
    webLocked = true
    plugin.getOwnFingerprint = () => null
    const { result } = renderHook(() => useOpenPgpOverviewState())
    expect(result.current).toBe('locked')
  })

  it('updates when a key unlock or recovery finishes elsewhere', async () => {
    plugin.getOwnFingerprint = () => null
    plugin.isKeyRecoveryNeeded = () => true
    const { result } = renderHook(() => useOpenPgpOverviewState())
    expect(result.current).toBe('needs-attention')
    plugin.getOwnFingerprint = () => FP
    plugin.isKeyRecoveryNeeded = () => false
    act(() => unlockListener?.())
    await waitFor(() => expect(result.current).toBe('on-backed-up'))
  })
})
