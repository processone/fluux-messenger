import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { useAdminStore } from '@fluux/sdk/react'

// Import after mock is set up via test-setup.ts
import { UserListItem } from './UserListItem'

function setAdminState(partial: Record<string, unknown>) {
  ;(useAdminStore as unknown as {
    mockImplementation: (impl: (selector?: (s: unknown) => unknown) => unknown) => void
  }).mockImplementation(
    (selector?: (s: unknown) => unknown) => {
      const state = {
        onlineJids: new Set<string>(),
        lastActivity: new Map(),
        lastActivitySupported: true,
        ...partial,
      }
      return selector ? selector(state) : state
    }
  )
}

describe('UserListItem', () => {
  it('shows "online now" and an online dot for online users', () => {
    setAdminState({})
    render(
      <UserListItem
        user={{ jid: 'a@x.com', username: 'a', isOnline: true }}
        onSelect={vi.fn()}
        requestLastActivity={vi.fn()}
      />
    )
    expect(screen.getByText('admin.users.onlineNow')).toBeInTheDocument()
    expect(screen.getByLabelText('admin.users.online')).toBeInTheDocument()
  })

  it('renders a relative time when last activity is loaded', () => {
    setAdminState({ lastActivity: new Map([['a@x.com', { state: 'loaded', seconds: 7200 }]]) })
    render(
      <UserListItem
        user={{ jid: 'a@x.com', username: 'a', isOnline: false }}
        onSelect={vi.fn()}
        requestLastActivity={vi.fn()}
      />
    )
    expect(screen.getByText(/ago/)).toBeInTheDocument()
  })

  it('renders nothing in the cell when last activity is null', () => {
    setAdminState({ lastActivity: new Map([['a@x.com', { state: 'loaded', seconds: null }]]) })
    render(
      <UserListItem
        user={{ jid: 'a@x.com', username: 'a', isOnline: false }}
        onSelect={vi.fn()}
        requestLastActivity={vi.fn()}
      />
    )
    expect(screen.queryByText(/ago/)).not.toBeInTheDocument()
  })

  it('hides the presence dot when online info is unavailable (isOnline undefined)', () => {
    setAdminState({})
    render(
      <UserListItem
        user={{ jid: 'a@x.com', username: 'a' }}
        onSelect={vi.fn()}
        requestLastActivity={vi.fn()}
      />
    )
    expect(screen.queryByLabelText('admin.users.online')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('admin.users.offline')).not.toBeInTheDocument()
  })
})
