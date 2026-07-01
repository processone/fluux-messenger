/**
 * @vitest-environment jsdom
 */
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
  it('fires onQuickChat directly from the bolt button', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Create Quick Chat' }))
    expect(props.onQuickChat).toHaveBeenCalledTimes(1)
  })

  it('groups the other room actions in the overflow menu (Quick Chat is not duplicated there)', () => {
    render(<RoomsHeaderActions {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('menuitem', { name: 'Permanent Room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Join room' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Browse Rooms' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Catch up all rooms' })).toBeInTheDocument()
    // Quick Chat lives on the bolt button only, not repeated as a menu item.
    expect(screen.queryByRole('menuitem', { name: 'Quick Chat' })).not.toBeInTheDocument()
  })

  it('separates the maintenance action from the create actions', () => {
    render(<RoomsHeaderActions {...baseProps()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    expect(screen.getByRole('separator')).toBeInTheDocument()
  })

  it('fires onPermanentRoom from the overflow menu and closes it', () => {
    const props = baseProps()
    render(<RoomsHeaderActions {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permanent Room' }))
    expect(props.onPermanentRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menuitem', { name: 'Permanent Room' })).not.toBeInTheDocument()
  })

  it('fires onCatchUpAll from the overflow menu', () => {
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
