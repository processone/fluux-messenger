import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Bell, Search, UserPlus } from 'lucide-react'
import { HeaderOverflowKebab, type OverflowEntry } from './HeaderOverflowKebab'

const mockHasHover = vi.fn(() => true)
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => mockHasHover(),
  hasHover: () => mockHasHover(),
}))

function makeEntries(onSearch = vi.fn(), onMode = vi.fn()): OverflowEntry[] {
  return [
    { kind: 'action', key: 'search', label: 'Search', icon: Search, onSelect: onSearch },
    { kind: 'action', key: 'invite', label: 'Invite', icon: UserPlus, onSelect: vi.fn() },
    {
      kind: 'submenu', key: 'notify', label: 'Notifications', icon: Bell,
      group: { title: 'Notifications', items: [
        { key: 'mentions', label: 'Mentions only', icon: Bell, onSelect: onMode },
      ] },
    },
  ]
}

describe('HeaderOverflowKebab', () => {
  beforeEach(() => { mockHasHover.mockReturnValue(true) })

  it('renders nothing with no entries', () => {
    const { container } = render(<HeaderOverflowKebab ariaLabel="More" entries={[]} />)
    expect(container.firstChild).toBeNull()
  })

  it('hover: opens an anchored dropdown with flat actions and a submenu section', () => {
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Invite')).toBeInTheDocument()
    // submenu group title acts as a section header in the dropdown
    expect(screen.getByText('Notifications')).toBeInTheDocument()
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
  })

  it('hover: selecting an action fires onSelect and closes', () => {
    const onSearch = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(onSearch)} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Search'))
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Invite')).not.toBeInTheDocument()
  })

  it('touch: opens a bottom sheet, navigates into a submenu and back', () => {
    mockHasHover.mockReturnValue(false)
    const onMode = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(vi.fn(), onMode)} />)
    fireEvent.click(screen.getByLabelText('More'))
    // root sheet shows the submenu as a navigable row
    fireEvent.click(screen.getByText('Notifications'))
    // sub-view shows the option
    fireEvent.click(screen.getByText('Mentions only'))
    expect(onMode).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
  })

  it('touch: back returns to root without firing actions', () => {
    mockHasHover.mockReturnValue(false)
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Notifications'))
    fireEvent.click(screen.getByLabelText('Back'))
    // root actions visible again
    expect(screen.getByText('Search')).toBeInTheDocument()
  })
})
