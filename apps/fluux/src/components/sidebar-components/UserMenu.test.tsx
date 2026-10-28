import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { UserMenu } from './UserMenu'
import { EscapeModal } from '@/test-utils/escapeModal'
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

// The captain's rulings on review R1 and R3, applied by review R5: Escape closes the menu
// and goes no further, and with stacked overlays it closes only the one on top.
describe('UserMenu — Escape', () => {
  it('closes shortcut help opened over it first, then closes and consumes Escape', () => {
    const closeHelp = vi.fn()
    const windowKeydown = vi.fn()
    const Page = ({ help }: { help: boolean }) => (
      <>
        <UserMenu onLogout={vi.fn()} />
        {help && <EscapeModal onClose={closeHelp} />}
      </>
    )
    const { rerender } = render(<Page help={false} />)
    openMenu()
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(screen.getByText('menu.about')).toBeInTheDocument()
    rerender(<Page help={false} />)
    window.addEventListener('keydown', windowKeydown)
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByText('menu.about')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})
