import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Contact } from '@fluux/sdk'
import type { ConversationEncryptionState } from '@/hooks/useConversationEncryptionState'
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

vi.mock('@/stores/conversationPlaintextOverrideStore', () => ({
  useConversationPlaintextOverrideStore: (selector: (s: { setForcedPlaintext: ReturnType<typeof vi.fn> }) => unknown) => {
    const state = { setForcedPlaintext: vi.fn() }
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
  beforeEach(() => vi.clearAllMocks())
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
