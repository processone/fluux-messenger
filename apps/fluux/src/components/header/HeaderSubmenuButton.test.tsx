import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Bell } from 'lucide-react'
import { HeaderSubmenuButton } from './HeaderSubmenuButton'

describe('HeaderSubmenuButton', () => {
  const group = {
    title: 'Notifications',
    items: [
      { key: 'mentions', label: 'Mentions only', icon: Bell, active: true, onSelect: vi.fn() },
      { key: 'all', label: 'All messages', icon: Bell, onSelect: vi.fn() },
    ],
  }

  it('opens the dropdown and lists the group items', () => {
    render(<HeaderSubmenuButton ariaLabel="Notify" tooltip="Notify" icon={Bell} group={group} />)
    fireEvent.click(screen.getByLabelText('Notify'))
    expect(screen.getByText('Mentions only')).toBeInTheDocument()
    expect(screen.getByText('All messages')).toBeInTheDocument()
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
})
