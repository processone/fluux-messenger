import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Contact } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
import { useToastStore } from '@/stores/toastStore'
import { ContactProfileView } from './ContactProfileView'

const defaultEncryptionState: ConversationEncryptionState = {
  kind: 'encrypted',
  fingerprint: 'ABCD1234',
  trust: 'verified',
}
const mockEncryptionState = vi.fn<() => ConversationEncryptionState>(() => defaultEncryptionState)
vi.mock('@/hooks/useConversationEncryptionState', () => ({
  useConversationEncryptionState: () => mockEncryptionState(),
}))

const defaultClient = { client: { e2ee: null as { getPlugin: (id: string) => unknown } | null } }
const mockClient = vi.fn(() => defaultClient)

// Mock hooks used by ContactProfileView that aren't covered by the global
// @fluux/sdk mock in test-setup.ts
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useXMPPContext: () => mockClient(),
    useBlocking: () => ({
      blockJid: vi.fn().mockResolvedValue(undefined),
      unblockJid: vi.fn().mockResolvedValue(undefined),
    }),
  }
})

vi.mock('@fluux/sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk/react')>()
  return {
    ...actual,
    useConnectionStore: vi.fn((selector) => {
      const state = {
        status: 'online',
        jid: 'me@example.com',
        windowVisible: true,
      }
      return selector ? selector(state) : state
    }),
    useBlockingStore: vi.fn((selector) => {
      const state = { blockedJids: new Set<string>() }
      return selector ? selector(state) : state
    }),
    useLastActivity: vi.fn(),
  }
})

// Mock app-level stores
vi.mock('@/stores/verifiedPeerKeysStore', () => ({
  useVerifiedPeerKeysStore: (selector: (s: { setVerified: ReturnType<typeof vi.fn>; clearVerified: ReturnType<typeof vi.fn> }) => unknown) => {
    const state = { setVerified: vi.fn(), clearVerified: vi.fn() }
    return selector ? selector(state) : state
  },
}))

// `setForcedPlaintext` is hoisted to module scope (rather than recreated
// inside the selector) to mirror real zustand action stability — actions
// keep the same reference across renders, and `ContactProfileView` relies
// on that stability to memoize the `identities` handle it hands to
// `SecurityTab` (see the "memoizes" test below).
const mockSetForcedPlaintext = vi.fn()
vi.mock('@/stores/conversationPlaintextOverrideStore', () => ({
  useConversationPlaintextOverrideStore: (selector: (s: { setForcedPlaintext: ReturnType<typeof vi.fn> }) => unknown) => {
    const state = { setForcedPlaintext: mockSetForcedPlaintext }
    return selector ? selector(state) : state
  },
}))

vi.mock('@/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks')>()
  return {
    ...actual,
    useWindowDrag: () => ({ dragRegionProps: {} }),
  }
})

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

const props = {
  contact,
  onStartConversation: vi.fn(),
  onRemoveContact: vi.fn(),
  onRenameContact: vi.fn(async () => {}),
  onFetchNickname: vi.fn(async () => null),
  onFetchVCard: vi.fn(async () => ({ org: 'ProcessOne' })),
}

describe('ContactProfileView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useToastStore.setState({ toasts: [] })
  })
  afterEach(() => {
    mockEncryptionState.mockReturnValue(defaultEncryptionState)
    mockClient.mockReturnValue(defaultClient)
  })

  it('shows the card grid and no tab bar', () => {
    render(<ContactProfileView {...props} />)
    expect(screen.getByText('Team')).toBeInTheDocument()
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  })

  it('opens the security detail when the glance card is clicked', () => {
    render(<ContactProfileView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    expect(screen.getByText('Security details')).toBeInTheDocument()
  })

  it('verifying an OMEMO device calls setIdentityTrust(peer, deviceId, "verified")', async () => {
    const setIdentityTrust = vi.fn().mockResolvedValue(undefined)
    const omemoPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: '111', fingerprint: 'aabb', trust: 'tofu' }]),
      getOwnFingerprint: vi.fn().mockResolvedValue('ccdd'),
      setIdentityTrust,
    }
    mockEncryptionState.mockReturnValue({
      kind: 'encrypted' as const,
      fingerprint: '',
      trust: 'tofu' as const,
      protocolId: 'omemo:2' as const,
    })
    mockClient.mockReturnValue({
      client: {
        e2ee: {
          getPlugin: (id: string) => (id === 'omemo:2' ? omemoPlugin : null),
        },
      },
    })

    const omemoContact = { ...contact, jid: 'bob@x' } as Contact
    render(<ContactProfileView {...props} contact={omemoContact} />)

    fireEvent.click(screen.getByRole('button', { name: 'Encrypted, not verified' }))
    expect(await screen.findByTestId('omemo-verify-111')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('omemo-verify-111'))

    // The dialog shows a "codeUnavailable" state because deriveSas isn't
    // stubbed here; fall back to the manual fingerprint-confirm path.
    await waitFor(() => expect(screen.getByText('chat.verifyPeer.dialogTitle')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.showFullFingerprints/ }))
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.confirmByFingerprint/ }))

    await waitFor(() => expect(setIdentityTrust).toHaveBeenCalledWith('bob@x', '111', 'verified'))
  })

  it('verifying an OpenPGP identity calls setIdentityTrust(peer, id, "verified") through the shared identities handle', async () => {
    const setIdentityTrust = vi.fn().mockResolvedValue(undefined)
    const openpgpPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'tofu' }]),
      getOwnFingerprint: vi.fn().mockReturnValue('ccdd'),
      setIdentityTrust,
    }
    mockEncryptionState.mockReturnValue({
      kind: 'encrypted' as const,
      fingerprint: 'ABCD1234',
      trust: 'tofu' as const,
    })
    mockClient.mockReturnValue({
      client: {
        e2ee: {
          getPlugin: (id: string) => (id === 'openpgp' ? openpgpPlugin : null),
        },
      },
    })

    render(<ContactProfileView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Encrypted, not verified' }))
    expect(await screen.findByTestId('omemo-verify-ABCD1234')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('omemo-verify-ABCD1234'))

    await waitFor(() => expect(screen.getByText('chat.verifyPeer.dialogTitle')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.showFullFingerprints/ }))
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.confirmByFingerprint/ }))

    await waitFor(() =>
      expect(setIdentityTrust).toHaveBeenCalledWith('sofia@process-one.net', 'ABCD1234', 'verified'),
    )
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts.some((toast) => toast.type === 'success')).toBe(true)
    })
  })

  // Regression coverage for Finding 1 of the Phase B1 final review:
  // `setIdentityTrust` now awaits a keychain/IPC/disk write and can reject.
  // Before the fix, the confirm handler chained a bare `.then()` with no
  // `.catch()`, so a rejection became an unhandled promise rejection, the
  // dialog silently stayed open, and the identity list never refreshed —
  // the user had no idea the verify failed. This proves the fix routes
  // through the same shared `useApplyIdentityTrust` helper ChatView uses:
  // an error toast on rejection, never a success toast, and the promise
  // never surfaces as unhandled.
  it('surfaces an error toast (never a success toast) instead of hanging when setIdentityTrust rejects', async () => {
    const setIdentityTrust = vi.fn().mockRejectedValue(new Error('boom'))
    const openpgpPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'tofu' }]),
      getOwnFingerprint: vi.fn().mockReturnValue('ccdd'),
      setIdentityTrust,
    }
    mockEncryptionState.mockReturnValue({
      kind: 'encrypted' as const,
      fingerprint: 'ABCD1234',
      trust: 'tofu' as const,
    })
    mockClient.mockReturnValue({
      client: {
        e2ee: {
          getPlugin: (id: string) => (id === 'openpgp' ? openpgpPlugin : null),
        },
      },
    })

    render(<ContactProfileView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Encrypted, not verified' }))
    expect(await screen.findByTestId('omemo-verify-ABCD1234')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('omemo-verify-ABCD1234'))

    await waitFor(() => expect(screen.getByText('chat.verifyPeer.dialogTitle')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.showFullFingerprints/ }))
    fireEvent.click(screen.getByRole('button', { name: /chat.verifyPeer.confirmByFingerprint/ }))

    await waitFor(() => expect(setIdentityTrust).toHaveBeenCalled())
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts
      expect(toasts.some((toast) => toast.type === 'error')).toBe(true)
    })
    expect(useToastStore.getState().toasts.some((toast) => toast.type === 'success')).toBe(false)
  })

  it('revoking an OpenPGP identity calls setIdentityTrust(peer, id, "untrusted") through the shared identities handle', async () => {
    const setIdentityTrust = vi.fn().mockResolvedValue(undefined)
    const openpgpPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: 'ABCD1234', fingerprint: 'ABCD1234', trust: 'verified' }]),
      getOwnFingerprint: vi.fn().mockReturnValue('ccdd'),
      setIdentityTrust,
    }
    mockEncryptionState.mockReturnValue({
      kind: 'encrypted' as const,
      fingerprint: 'ABCD1234',
      trust: 'verified' as const,
    })
    mockClient.mockReturnValue({
      client: {
        e2ee: {
          getPlugin: (id: string) => (id === 'openpgp' ? openpgpPlugin : null),
        },
      },
    })

    render(<ContactProfileView {...props} />)

    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    expect(await screen.findByTestId('omemo-revoke-ABCD1234')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('omemo-revoke-ABCD1234'))

    await waitFor(() =>
      expect(setIdentityTrust).toHaveBeenCalledWith('sofia@process-one.net', 'ABCD1234', 'untrusted'),
    )
  })

  it('memoizes the omemo prop so it is not reconstructed on every parent re-render', async () => {
    const omemoPlugin = {
      listPeerIdentities: vi.fn().mockResolvedValue([{ id: '111', fingerprint: 'aabb', trust: 'tofu' }]),
      getOwnFingerprint: vi.fn().mockResolvedValue('ccdd'),
      setIdentityTrust: vi.fn().mockResolvedValue(undefined),
    }
    mockEncryptionState.mockReturnValue({
      kind: 'encrypted' as const,
      fingerprint: '',
      trust: 'tofu' as const,
      protocolId: 'omemo:2' as const,
    })
    mockClient.mockReturnValue({
      client: {
        e2ee: {
          getPlugin: (id: string) => (id === 'omemo:2' ? omemoPlugin : null),
        },
      },
    })

    const omemoContact = { ...contact, jid: 'bob@x' } as Contact
    const { rerender } = render(<ContactProfileView {...props} contact={omemoContact} />)

    fireEvent.click(screen.getByRole('button', { name: 'Encrypted, not verified' }))
    await screen.findByTestId('omemo-verify-111')
    expect(omemoPlugin.listPeerIdentities).toHaveBeenCalledTimes(1)

    // An unrelated parent re-render (same peer, same plugin, no reload)
    // must NOT recreate the `omemo` prop object passed to SecurityTab, or
    // its fetch effect (keyed on the whole object) would refire and flash
    // the loading spinner on every re-render.
    rerender(<ContactProfileView {...props} contact={omemoContact} />)
    expect(omemoPlugin.listPeerIdentities).toHaveBeenCalledTimes(1)
  })
})
