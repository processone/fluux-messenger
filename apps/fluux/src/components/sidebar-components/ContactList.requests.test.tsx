import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactList } from './ContactList'

const acceptSubscription = vi.fn()
const rejectSubscription = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useEvents: () => ({
      subscriptionRequests: [{ id: 'r1', from: 'alice@example.com', timestamp: new Date() }],
      acceptSubscription,
      rejectSubscription,
    }),
    useBlocking: () => ({ blockJid: vi.fn() }),
    useContactIdentities: () => new Map(),
    useRosterActions: () => ({ removeContact: vi.fn(), renameContact: vi.fn(async () => {}) }),
    useAdminPermissions: () => ({ isAdmin: false, hasUserCommands: false, canManageUser: () => false }),
    rosterStore: { getState: () => ({ contacts: new Map() }) },
  }
})

// Roster empty so only the Requests section renders.
vi.mock('@fluux/sdk/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk/react')>()
  return {
    ...actual,
    useConnectionStore: (selector: (s: { status: string }) => unknown) => selector({ status: 'online' }),
    useRosterStore: (selector: (s: { contactSidebarEntries: () => string[]; contacts: Map<string, unknown> }) => unknown) =>
      selector({ contactSidebarEntries: () => [], contacts: new Map() }),
  }
})

describe('ContactList — Requests section', () => {
  it('renders pending subscription requests with Accept/Reject', () => {
    render(<ContactList />)
    expect(screen.getByText(/contacts\.requestsHeading/)).toBeInTheDocument()
    expect(screen.getByText('alice')).toBeInTheDocument()
    fireEvent.click(screen.getByText('common.accept'))
    expect(acceptSubscription).toHaveBeenCalledWith('alice@example.com')
  })
})
