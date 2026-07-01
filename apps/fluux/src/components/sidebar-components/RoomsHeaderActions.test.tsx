import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { RoomsHeaderActions } from './RoomsHeaderActions'

const baseProps = () => ({
  onQuickChat: vi.fn(),
  onPermanentRoom: vi.fn(),
  onJoinRoom: vi.fn(),
  onBrowseRooms: vi.fn(),
  onCatchUpAll: vi.fn(),
  isCatchingUp: false,
})

describe('RoomsHeaderActions', () => {
  it('fires onQuickChat directly from the + button', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Quick Chat' }))
    expect(props.onQuickChat).toHaveBeenCalledTimes(1)
  })

  it('opens the create-menu from the chevron with all four paths', () => {
    render(<RoomsHeaderActions {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }))
    expect(screen.getByRole('menuitem', { name: 'Quick Chat' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Permanent Room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Join room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Browse Rooms' })).toBeInTheDocument()
  })

  it('fires onPermanentRoom from the create-menu and closes it', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permanent Room' }))
    expect(props.onPermanentRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Permanent Room' })).not.toBeInTheDocument()
  })

  it('exposes Catch up all in the overflow menu and fires it', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Catch up all rooms' }))
    expect(props.onCatchUpAll).toHaveBeenCalledTimes(1)
  })

  it('disables Catch up all while catching up', () => {
    render(<RoomsHeaderActions {...baseProps()} isCatchingUp />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    const item = screen.getByRole('menuitem', { name: 'Catch up all rooms' })
    expect(item).toBeDisabled()
  })
})
