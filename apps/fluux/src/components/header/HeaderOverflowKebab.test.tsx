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

  it('hover: opens an anchored dropdown with actions and a submenu row that opens its items', () => {
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(screen.getByText('Invite')).toBeInTheDocument()
    // A submenu is one row; its items stay hidden until it is opened.
    expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Notifications'))
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
    expect(screen.queryByText('Invite')).not.toBeInTheDocument()
  })

  it('hover: Escape in a submenu returns to the root list with focus on its row, then closes', () => {
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Notifications'))
    const back = screen.getByLabelText('Back')
    expect(back).toHaveFocus()
    fireEvent.keyDown(back, { key: 'Escape' })
    const row = screen.getByText('Notifications').closest('button')!
    expect(row).toHaveFocus()
    expect(screen.getByText('Invite')).toBeInTheDocument()
    fireEvent.keyDown(row, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('hover: the back row returns to the root list without firing actions', () => {
    const onSearch = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(onSearch)} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Notifications'))
    fireEvent.click(screen.getByLabelText('Back'))
    expect(screen.getByText('Search')).toBeInTheDocument()
    expect(onSearch).not.toHaveBeenCalled()
  })

  it('hover: selecting an action fires onSelect and closes', () => {
    const onSearch = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(onSearch)} />)
    fireEvent.click(screen.getByLabelText('More'))
    fireEvent.click(screen.getByText('Search'))
    expect(onSearch).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Invite')).not.toBeInTheDocument()
  })

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // Regression (image-scroll-position-reset follow-up): this kebab lives in the
    // conversation/room header. Closing it with Escape must not also fire the
    // window shortcut that scrolls the conversation to the bottom and marks it read.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
      fireEvent.click(screen.getByLabelText('More'))
      expect(screen.getByText('Search')).toBeInTheDocument()

      fireEvent.keyDown(document.body, { key: 'Escape' })

      expect(screen.queryByText('Search')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('leaves Escape alone while closed (window handler still runs)', () => {
    // The listener is gated on the open state: a closed kebab must not swallow
    // Escape meant for the conversation underneath.
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('touch: opens an anchored menu, navigates into a submenu and back', () => {
    mockHasHover.mockReturnValue(false)
    const onMode = vi.fn()
    render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries(vi.fn(), onMode)} />)
    fireEvent.click(screen.getByLabelText('More'))
    // root menu shows the submenu as a navigable row
    fireEvent.click(screen.getByText('Notifications'))
    // sub-view shows the option
    fireEvent.click(screen.getByText('Mentions only'))
    expect(onMode).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
  })

  it.each([['hover', true], ['touch', false]])('%s: draws a divider above a row marked separatorBefore', (_name, hover) => {
    mockHasHover.mockReturnValue(hover)
    const entries: OverflowEntry[] = [
      { kind: 'action', key: 'a', label: 'First', icon: Search, onSelect: vi.fn() },
      { kind: 'action', key: 'b', label: 'Second', icon: UserPlus, onSelect: vi.fn(), separatorBefore: true },
    ]
    render(<HeaderOverflowKebab ariaLabel="More" entries={entries} />)
    fireEvent.click(screen.getByLabelText('More'))
    expect(screen.getByText('Second').closest('.border-t')).not.toBeNull()
    expect(screen.getByText('First').closest('.border-t')).toBeNull()
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

it('touch: Escape returns from a submenu with focus on its opener', () => {
  mockHasHover.mockReturnValue(false)
  render(<HeaderOverflowKebab ariaLabel="More" entries={makeEntries()} />)
  fireEvent.click(screen.getByLabelText('More'))
  screen.getByRole('button', { name: 'Notifications' }).focus()
  fireEvent.click(screen.getByText('Notifications'))
  const back = screen.getByLabelText('Back')
  expect(back).toHaveFocus()
  fireEvent.keyDown(back, { key: 'Escape' })
  expect(screen.getByRole('button', { name: 'Notifications' })).toHaveFocus()
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})
