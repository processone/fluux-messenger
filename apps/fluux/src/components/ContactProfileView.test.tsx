import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileView } from './ContactProfileView'
import { useToastStore } from '@/stores/toastStore'

const e2ee = vi.hoisted(() => ({
  setIdentityTrust: vi.fn(async () => {}),
  getOwnFingerprint: vi.fn(async () => 'OWN1234'),
}))

const encState = vi.hoisted(() => ({
  current: null as unknown,
  oneKey: {
    kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', fingerprint: 'ABCD1234', trust: 'verified',
    identityId: 'ABCD1234', canClearVerification: true,
  },
}))

vi.mock('@/hooks/useConversationEncryptionState', () => ({
  useConversationEncryptionState: () => encState.current ?? encState.oneKey,
}))

// Mock hooks used by ContactProfileView that aren't covered by the global
// @fluux/sdk mock in test-setup.ts
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useXMPPContext: () => ({
      client: {
        e2ee,
      },
    }),
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
  onFetchProfileDetails: vi.fn(async () => ({ org: 'ProcessOne' })),
}

describe('ContactProfileView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    encState.current = null
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

  it('removes a verification through the SDK for the key in use', async () => {
    render(<ContactProfileView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    fireEvent.click(screen.getByRole('button', { name: /removeVerification|Remove verification/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /removeVerification|Remove verification/ }).at(-1)!)
    await waitFor(() => expect(e2ee.setIdentityTrust).toHaveBeenCalledWith('openpgp', contact.jid, 'ABCD1234', 'tofu'))
  })

  it('shows a failed trust decision to the person instead of dropping it', async () => {
    e2ee.setIdentityTrust.mockRejectedValueOnce(new Error('keys changed'))
    render(<ContactProfileView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    fireEvent.click(screen.getByRole('button', { name: /removeVerification|Remove verification/ }))
    fireEvent.click(screen.getAllByRole('button', { name: /removeVerification|Remove verification/ }).at(-1)!)
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message === 'keys changed')).toBe(true),
    )
  })

  it('still sends the decision for the key the dialog opened for when a second key arrives, so the SDK can refuse it visibly', async () => {
    const { rerender } = render(<ContactProfileView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    fireEvent.click(screen.getByRole('button', { name: /removeVerification|Remove verification/ }))
    // The contact now has two keys: no decision is offered and the state carries no key id.
    encState.current = { kind: 'encrypted', protocolId: 'openpgp', displayName: 'OpenPGP', fingerprint: 'ABCD1234', trust: 'tofu', partlyVerified: true }
    e2ee.setIdentityTrust.mockRejectedValueOnce(new Error('decision not allowed'))
    rerender(<ContactProfileView {...props} />)
    fireEvent.click(screen.getAllByRole('button', { name: /removeVerification|Remove verification/ }).at(-1)!)
    await waitFor(() => expect(e2ee.setIdentityTrust).toHaveBeenCalledWith('openpgp', contact.jid, 'ABCD1234', 'tofu'))
    await waitFor(() =>
      expect(useToastStore.getState().toasts.some((t) => t.type === 'error' && t.message === 'decision not allowed')).toBe(true),
    )
  })
})
