/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactsHeaderActions } from './ContactsHeaderActions'

describe('ContactsHeaderActions', () => {
  it('fires onAddContact when the add button is clicked', () => {
    const onAddContact = vi.fn()
    render(<ContactsHeaderActions onAddContact={onAddContact} onOpenBlocked={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Add contact' }))
    expect(onAddContact).toHaveBeenCalledTimes(1)
  })

  it('opens the overflow menu and fires onOpenBlocked', () => {
    const onOpenBlocked = vi.fn()
    render(<ContactsHeaderActions onAddContact={vi.fn()} onOpenBlocked={onOpenBlocked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Blocked users' }))
    expect(onOpenBlocked).toHaveBeenCalledTimes(1)
  })
})
