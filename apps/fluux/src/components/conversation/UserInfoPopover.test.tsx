/**
 * UserInfoPopover tests - vCard display functionality.
 *
 * Tests that the popover fetches and displays vCard info (full name, org, email, country)
 * when opened by clicking on a contact avatar/name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { UserInfoPopover, _vcardCacheForTesting } from './UserInfoPopover'
import type { VCardInfo } from '@fluux/sdk'

// Track the mock fetchVCard function
const mockFetchVCard = vi.fn<(jid: string) => Promise<VCardInfo | null>>()

// Override the useXMPP mock for this test file
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useXMPP: () => ({
      client: { profile: { fetchVCard: mockFetchVCard } },
      sendRawXml: vi.fn(),
      onStanza: vi.fn(() => vi.fn()),
      on: vi.fn(() => vi.fn()),
      setPresence: vi.fn(),
      xml: vi.fn(),
      isConnected: () => true,
      getJid: () => 'me@example.com',
    }),
  }
})

describe('UserInfoPopover', () => {
  beforeEach(() => {
    mockFetchVCard.mockReset()
    // Clear the module-level vCard cache between tests
    _vcardCacheForTesting.clear()
  })

  it('should render trigger element', () => {
    render(
      <UserInfoPopover jid="alice@example.com">
        <span>Alice</span>
      </UserInfoPopover>
    )

    expect(screen.getByText('Alice')).toBeInTheDocument()
  })

  it('should show JID when popover is opened', () => {
    mockFetchVCard.mockResolvedValue(null)

    render(
      <UserInfoPopover jid="alice@example.com">
        <span>Alice</span>
      </UserInfoPopover>
    )

    fireEvent.click(screen.getByText('Alice'))

    expect(screen.getByText('alice@example.com')).toBeInTheDocument()
  })

  it('should fetch and display vCard info on open', async () => {
    mockFetchVCard.mockResolvedValue({
      fullName: 'Alice Smith',
      org: 'Acme Corp',
      email: 'alice@acme.com',
      country: 'France',
    })

    render(
      <UserInfoPopover jid="alice@example.com">
        <span>Alice</span>
      </UserInfoPopover>
    )

    await act(async () => {
      fireEvent.click(screen.getByText('Alice'))
    })

    await waitFor(() => {
      expect(screen.getByText('Alice Smith')).toBeInTheDocument()
    })
    expect(screen.getByText('Acme Corp')).toBeInTheDocument()
    expect(screen.getByText('alice@acme.com')).toBeInTheDocument()
    expect(screen.getByText('France')).toBeInTheDocument()
  })

  it('should fetch vCard using contact jid', async () => {
    mockFetchVCard.mockResolvedValue({ fullName: 'Bob' })

    render(
      <UserInfoPopover
        contact={{ jid: 'bob@example.com', name: 'Bob', avatar: undefined, colorLight: '#000', colorDark: '#fff' }}
      >
        <span>Bob</span>
      </UserInfoPopover>
    )

    fireEvent.click(screen.getByText('Bob'))

    await waitFor(() => {
      expect(mockFetchVCard).toHaveBeenCalledWith('bob@example.com')
    })
  })

  it('should fall back to occupantJid for vCard fetch', async () => {
    mockFetchVCard.mockResolvedValue({ fullName: 'Anonymous User' })

    render(
      <UserInfoPopover occupantJid="room@conference.example.com/anon">
        <span>Anon</span>
      </UserInfoPopover>
    )

    fireEvent.click(screen.getByText('Anon'))

    await waitFor(() => {
      expect(mockFetchVCard).toHaveBeenCalledWith('room@conference.example.com/anon')
    })
  })

  it('should not show vCard section when fetch returns null', async () => {
    mockFetchVCard.mockResolvedValue(null)

    render(
      <UserInfoPopover jid="empty@example.com">
        <span>Empty</span>
      </UserInfoPopover>
    )

    fireEvent.click(screen.getByText('Empty'))

    await waitFor(() => {
      expect(mockFetchVCard).toHaveBeenCalled()
    })

    // Only JID should be visible, no vCard fields
    expect(screen.getByText('empty@example.com')).toBeInTheDocument()
    expect(screen.queryByText('Alice Smith')).not.toBeInTheDocument()
  })

  it('should show partial vCard when only some fields are available', async () => {
    mockFetchVCard.mockResolvedValue({
      fullName: 'Charlie',
      org: undefined,
      email: 'charlie@test.com',
      country: undefined,
    })

    render(
      <UserInfoPopover jid="charlie@example.com">
        <span>Charlie</span>
      </UserInfoPopover>
    )

    fireEvent.click(screen.getByText('Charlie'))

    await waitFor(() => {
      expect(screen.getByText('Charlie')).toBeInTheDocument()
    })
    expect(screen.getByText('charlie@test.com')).toBeInTheDocument()
  })
})
