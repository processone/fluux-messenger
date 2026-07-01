import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileView } from './ContactProfileView'

vi.mock('@/hooks/useConversationEncryptionState', () => ({
  useConversationEncryptionState: () => ({ kind: 'encrypted', fingerprint: 'ABCD1234', trust: 'verified' }),
}))

// Mock hooks used by ContactProfileView that aren't covered by the global
// @fluux/sdk mock in test-setup.ts
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useXMPPContext: () => ({
      client: {
        e2ee: null,
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
})
