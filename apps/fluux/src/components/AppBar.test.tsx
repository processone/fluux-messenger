import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { AppBar } from './AppBar'
import { setPlatformForTesting } from '@/platform'

// One seam for the platform, shared with the app code under test.
let restorePlatform: (() => void) | undefined
function usePlatform(shell: 'desktop' | 'web', os: 'macos' | 'windows' | 'linux' = 'macos') {
  restorePlatform?.()
  restorePlatform = setPlatformForTesting({ shell, os })
}

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
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
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
  afterEach(() => {
    restorePlatform?.()
    restorePlatform = undefined
  })

  beforeEach(() => {
    mockIsDesktop = true
    mockHasHover = true
    navigateSpy.mockClear()
    toggleSpy.mockClear()
    // Default to the web build; the desktop-app tests opt in explicitly.
    usePlatform('web')
    // Reset history position so each test starts at index 0 (start = end).
    window.history.replaceState(null, '')
  })

  it('renders nothing on mobile web (below the desktop breakpoint)', () => {
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

  it('still renders on the desktop app in a narrow window (Tauri, below the breakpoint)', () => {
    usePlatform('desktop')
    mockIsDesktop = false
    mockHasHover = false
    renderAppBar()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument()
  })

  it('renders back, forward and command-palette controls on desktop', () => {
    renderAppBar()
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Forward' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open command palette' })).toBeInTheDocument()
  })

  it('does not duplicate the settings control (it lives in the rail)', () => {
    renderAppBar()
    expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('disables back at the first history entry', () => {
    renderAppBar()
    // Fresh history starts at index 0 → nowhere to go back.
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled()
  })

  it('disables forward at the end of history', () => {
    renderAppBar()
    // At the furthest index reached → nowhere to go forward.
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled()
  })

  it('navigates back when not at the first history entry', () => {
    // Simulate being one step into the history stack.
    window.history.replaceState({ idx: 1 }, '')
    renderAppBar()
    const back = screen.getByRole('button', { name: 'Back' })
    expect(back).toBeEnabled()
    fireEvent.click(back)
    expect(navigateSpy).toHaveBeenCalledWith(-1)
  })

  it('opens the command palette from the command-palette control', () => {
    renderAppBar()
    fireEvent.click(screen.getByRole('button', { name: 'Open command palette' }))
    expect(toggleSpy).toHaveBeenCalledWith('commandPalette')
  })
})
