import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ContactActionsMenu } from './ContactActionsMenu'

// i18n mock: t returns the key verbatim, so labels render as their keys.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}))

const noop = () => {}

const baseProps = {
  isInRoster: true,
  isBlocked: false,
  canAdd: false,
  onRename: noop,
  onRemove: noop,
  onBlock: noop,
  onUnblock: noop,
  onAdd: noop,
}

const openMenu = () =>
  fireEvent.click(screen.getByRole('button', { name: 'contacts.actionsMenu' }))

describe('ContactActionsMenu', () => {
  it('renders rename, block and remove for a roster contact', () => {
    render(<ContactActionsMenu {...baseProps} />)
    openMenu()

    expect(screen.getByText('contacts.rename')).toBeInTheDocument()
    expect(screen.getByText('contacts.blockUser')).toBeInTheDocument()
    expect(screen.getByText('contacts.removeFromRoster')).toBeInTheDocument()
    expect(screen.queryByText('contacts.unblockUser')).not.toBeInTheDocument()
    expect(screen.queryByText('contacts.addToContacts')).not.toBeInTheDocument()
  })

  it('shows unblock instead of block when the contact is blocked', () => {
    render(<ContactActionsMenu {...baseProps} isBlocked />)
    openMenu()

    expect(screen.getByText('contacts.unblockUser')).toBeInTheDocument()
    expect(screen.queryByText('contacts.blockUser')).not.toBeInTheDocument()
  })

  it('shows add-to-contacts for a non-roster contact and calls onAdd', () => {
    const onAdd = vi.fn()
    render(
      <ContactActionsMenu {...baseProps} isInRoster={false} canAdd onAdd={onAdd} />,
    )
    openMenu()

    fireEvent.click(screen.getByText('contacts.addToContacts'))
    expect(onAdd).toHaveBeenCalledTimes(1)
    // No roster-only actions for a stranger.
    expect(screen.queryByText('contacts.rename')).not.toBeInTheDocument()
    expect(screen.queryByText('contacts.removeFromRoster')).not.toBeInTheDocument()
  })

  it('calls onBlock when the block item is clicked', () => {
    const onBlock = vi.fn()
    render(<ContactActionsMenu {...baseProps} onBlock={onBlock} />)
    openMenu()

    fireEvent.click(screen.getByText('contacts.blockUser'))
    expect(onBlock).toHaveBeenCalledTimes(1)
  })
})
