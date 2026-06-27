import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { UserMenu } from './UserMenu'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let consoleIsOpen = false
const toggleConsoleSpy = vi.fn()
vi.mock('@fluux/sdk', () => ({
  useConsole: () => ({ toggle: toggleConsoleSpy, isOpen: consoleIsOpen }),
}))

vi.mock('@/hooks', () => ({
  useClickOutside: () => {},
  useIsMobileWeb: () => false,
  useAnchoredMenu: () => ({
    triggerRef: { current: null },
    menuRef: { current: null },
    position: { x: 0, y: 0 },
  }),
}))

vi.mock('@/stores/modalStore', () => ({
  useModalStore: (selector: (s: unknown) => unknown) => selector({ open: vi.fn() }),
}))

vi.mock('../AboutModal', () => ({ AboutModal: () => null }))
vi.mock('../ChangelogModal', () => ({ ChangelogModal: () => null }))
vi.mock('../Tooltip', () => ({ Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</> }))

function openMenu() {
  // When closed, the only button is the kebab trigger.
  fireEvent.click(screen.getAllByRole('button')[0])
}

beforeEach(() => {
  consoleIsOpen = false
  toggleConsoleSpy.mockClear()
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('UserMenu — console gating', () => {
  it('hides the console toggle when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<UserMenu onLogout={vi.fn()} />)
    openMenu()
    expect(screen.queryByText('menu.showConsole')).not.toBeInTheDocument()
  })

  it('shows the console toggle when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<UserMenu onLogout={vi.fn()} />)
    openMenu()
    expect(screen.getByText('menu.showConsole')).toBeInTheDocument()
  })

  it('closes the console when advanced mode is turned off while it is open', () => {
    consoleIsOpen = true
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<UserMenu onLogout={vi.fn()} />)
    expect(toggleConsoleSpy).not.toHaveBeenCalled()

    act(() => {
      useAdvancedModeStore.getState().setAdvancedMode(false)
    })
    expect(toggleConsoleSpy).toHaveBeenCalledTimes(1)
  })
})
