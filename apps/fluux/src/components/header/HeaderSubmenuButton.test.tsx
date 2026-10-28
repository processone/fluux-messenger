import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { HeaderSubmenuButton } from './HeaderSubmenuButton'
import { EscapeModal } from '@/test-utils/escapeModal'

describe('HeaderSubmenuButton', () => {
  const group = {
    title: 'Notifications',
    items: [
      { key: 'mentions', label: 'Mentions only', icon: Bell, active: true, onSelect: vi.fn() },
      { key: 'all', label: 'All messages', icon: Bell, onSelect: vi.fn() },
    ],
  }

  it('opens the dropdown and lists the group items', () => {
    const { container } = render(<HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={group} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
    expect(screen.getByText('All messages')).toBeInTheDocument()
    expect(container.querySelector('.lucide-chevron-down')).toHaveClass(
      '[transition-duration:var(--fluux-duration-fast)]',
    )
    expect(screen.getByRole('menu')).toHaveClass('header-submenu-in')
  })

  it('fires an item onSelect and closes', () => {
    const onSelect = vi.fn()
    const g = { ...group, items: [{ key: 'mentions', label: 'Mentions only', icon: Bell, onSelect }] }
    render(<HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={g} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    fireEvent.click(screen.getByText('Mentions only'))
    expect(onSelect).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
  })

  // The captain's rulings on review R1 and R3, applied by review R5: Escape closes the
  // submenu and goes no further, and with stacked overlays it closes only the one on top.
  it('closes shortcut help opened over it first, then closes and consumes Escape', () => {
    const closeHelp = vi.fn()
    const windowKeydown = vi.fn()
    const Page = ({ help }: { help: boolean }) => (
      <>
        <HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={group} />
        {help && <EscapeModal onClose={closeHelp} />}
      </>
    )
    const { rerender } = render(<Page help={false} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    rerender(<Page help />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(closeHelp).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
    rerender(<Page help={false} />)
    window.addEventListener('keydown', windowKeydown)
    try {
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(screen.queryByText('Mentions only')).not.toBeInTheDocument()
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })
})
