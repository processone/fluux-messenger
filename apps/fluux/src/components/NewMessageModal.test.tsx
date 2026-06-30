import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { NewMessageModal } from './NewMessageModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

function setup() {
  const onClose = vi.fn()
  const onPick = vi.fn()
  const onAddContact = vi.fn()
  const onManageContacts = vi.fn()
  render(
    <NewMessageModal onClose={onClose} onPick={onPick} onAddContact={onAddContact} onManageContacts={onManageContacts} />
  )
  return { onClose, onPick, onAddContact, onManageContacts }
}

describe('NewMessageModal', () => {
  it('renders the picker title and action rows', () => {
    setup()
    expect(screen.getByText('newMessage.title')).toBeInTheDocument()
    expect(screen.getByText('contacts.addContact')).toBeInTheDocument()
    expect(screen.getByText('newMessage.manageContacts')).toBeInTheDocument()
  })

  it('picks a typed JID and closes', () => {
    const { onPick, onClose } = setup()
    const input = screen.getByPlaceholderText('newMessage.searchPlaceholder')
    fireEvent.change(input, { target: { value: 'carol@example.com' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('carol@example.com')
    expect(onClose).toHaveBeenCalled()
  })

  it('invokes onAddContact and onManageContacts from the rows', () => {
    const { onAddContact, onManageContacts, onClose } = setup()
    fireEvent.click(screen.getByText('contacts.addContact'))
    expect(onAddContact).toHaveBeenCalled()
    // Add contact stacks a modal on top — the picker stays open.
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('newMessage.manageContacts'))
    expect(onManageContacts).toHaveBeenCalled()
    // Manage contacts navigates away — the picker closes.
    expect(onClose).toHaveBeenCalled()
  })
})
