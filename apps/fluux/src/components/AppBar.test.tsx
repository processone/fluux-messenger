import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AppBar } from './AppBar'

// Reactive gates — toggled per test.
let mockIsDesktop = true
let mockHasHover = true
vi.mock('@/hooks/useIsDesktop', () => ({
  useIsDesktop: () => mockIsDesktop,
}))
vi.mock('@/hooks/useHasHover', () => ({
  useHasHover: () => mockHasHover,
}))
vi.mock('@/hooks/useFullscreen', () => ({
  useFullscreen: () => false,
}))

const navigateSpy = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigateSpy }
})

const toggleSpy = vi.fn()
vi.mock('@/stores/modalStore', () => ({
  useModalStore: (selector: (s: { toggle: (m: string) => void }) => unknown) =>
    selector({ toggle: toggleSpy }),
}))

function renderAppBar() {
  return render(
    <MemoryRouter>
      <AppBar />
    </MemoryRouter>,
  )
}

describe('AppBar', () => {
  beforeEach(() => {
    mockIsDesktop = true
    mockHasHover = true
    navigateSpy.mockClear()
    toggleSpy.mockClear()
  })

  it('renders nothing on mobile (below the desktop breakpoint)', () => {
    mockIsDesktop = false
    const { container } = renderAppBar()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing on a touch device even when wide (e.g. phone in landscape)', () => {
    mockIsDesktop = true
    mockHasHover = false
    const { container } = renderAppBar()
    expect(container).toBeEmptyDOMElement()
  })

  it('renders back, forward and search controls on desktop', () => {
    renderAppBar()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
  })

  it('does not duplicate the settings control (it lives in the rail)', () => {
    renderAppBar()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('navigates forward through history', () => {
    renderAppBar()
    fireEvent.click(screen.getByRole('button', { name: 'Forward' }))
    expect(navigateSpy).toHaveBeenCalledWith(1)
  })

  it('disables back at the first history entry', () => {
    renderAppBar()
    // Fresh history starts at index 0 → nowhere to go back.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('opens the command palette from the search control', () => {
    renderAppBar()
    fireEvent.click(screen.getByText('Search'))
    expect(toggleSpy).toHaveBeenCalledWith('commandPalette')
  })
})
