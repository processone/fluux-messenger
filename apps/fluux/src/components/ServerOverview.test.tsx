import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ServerOverview } from './ServerOverview'

const fetchServerStats = vi.fn()
let adminReturn: Record<string, unknown>

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return { ...actual, useAdmin: () => adminReturn }
})

beforeEach(() => {
  fetchServerStats.mockReset()
  adminReturn = {
    serverStats: { registeredUsers: 15, onlineUsers: 7, onlineRooms: 10, uptimeSeconds: 86400, version: 'ejabberd 26.01', vhostCount: 1, fetchedAt: Date.now() },
    isLoadingStats: false,
    fetchServerStats,
  }
})

describe('ServerOverview', () => {
  it('renders a card per present metric', () => {
    render(<ServerOverview />)
    expect(screen.getByText('Registered users')).toBeInTheDocument()
    expect(screen.getByText('15')).toBeInTheDocument()
    expect(screen.getByText('Active rooms')).toBeInTheDocument()
    expect(screen.getByText('1d')).toBeInTheDocument() // uptime 86400 -> "1d"
  })

  it('omits cards for absent metrics', () => {
    adminReturn.serverStats = { registeredUsers: 15, fetchedAt: Date.now() }
    render(<ServerOverview />)
    expect(screen.getByText('Registered users')).toBeInTheDocument()
    expect(screen.queryByText('Server version')).not.toBeInTheDocument()
  })

  it('fetches on mount and on Refresh click', () => {
    render(<ServerOverview />)
    expect(fetchServerStats).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(fetchServerStats).toHaveBeenCalledTimes(2)
  })

  it('shows the empty state when no stats are available', () => {
    adminReturn.serverStats = null
    render(<ServerOverview />)
    expect(screen.getByText('Server statistics are unavailable.')).toBeInTheDocument()
  })
})
