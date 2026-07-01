import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { ContactProfileGrid } from './ContactProfileGrid'

const contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
  groups: ['Team'],
} as Contact

describe('ContactProfileGrid', () => {
  it('renders the shared group and the security glance, and opens security on click', () => {
    const onOpenSecurity = vi.fn()
    render(
      <ContactProfileGrid
        contact={contact}
        vcard={{ org: 'ProcessOne' }}
        isInRoster={true}
        forceOffline={false}
        encryptionState={{ kind: 'encrypted', fingerprint: 'AB', trust: 'verified' }}
        onOpenSecurity={onOpenSecurity}
      />,
    )
    expect(screen.getByText('ProcessOne')).toBeInTheDocument()
    expect(screen.getByText('Team')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Verified and encrypted' }))
    expect(onOpenSecurity).toHaveBeenCalledOnce()
  })

  it('hides the shared card for a non-roster contact', () => {
    render(
      <ContactProfileGrid
        contact={contact}
        vcard={null}
        isInRoster={false}
        forceOffline={false}
        encryptionState={{ kind: 'disabled' }}
        onOpenSecurity={() => {}}
      />,
    )
    expect(screen.queryByText('Groups')).not.toBeInTheDocument()
  })
})
