import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileHero } from './ContactProfileHero'

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

const noop = () => {}

function renderHero() {
  return render(
    <ContactProfileHero
      contact={contact} isInRoster={true} forceOffline={false}
      presenceColor="bg-green-500" statusText="Online" pepNickname={null}
      isEditing={false} editName="Sofia" saving={false} error={null}
      onEditNameChange={noop} onStartEdit={noop} onSaveEdit={noop}
      onCancelEdit={noop} onStartConversation={noop}
    />,
  )
}

describe('ContactProfileHero', () => {
  it('renders the name and the message CTA', () => {
    renderHero()
    expect(screen.getByRole('heading', { name: 'Sofia' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Start conversation/i })).toBeInTheDocument()
  })

  it('does not render group pills in the hero (they live in the Shared card)', () => {
    renderHero()
    expect(screen.queryByText('Team')).not.toBeInTheDocument()
  })
})
