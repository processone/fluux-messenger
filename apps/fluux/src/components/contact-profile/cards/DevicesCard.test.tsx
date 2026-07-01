import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import type { Contact } from '@fluux/sdk'
import { DevicesCard } from './DevicesCard'

const base: Contact = {
  jid: 'sofia@process-one.net', name: 'Sofia', presence: 'online', subscription: 'both',
} as Contact

describe('DevicesCard', () => {
  it('renders one row per resource', () => {
    const contact = {
      ...base,
      resources: new Map([
        ['desktop', { show: null, status: '', priority: 1, client: 'Fluux Desktop' }],
      ]),
    } as Contact
    render(<DevicesCard contact={contact} forceOffline={false} />)
    expect(screen.getByText('Connected devices')).toBeInTheDocument()
    expect(screen.getByText('Fluux Desktop')).toBeInTheDocument()
  })

  it('returns null when there are no resources', () => {
    const { container } = render(<DevicesCard contact={base} forceOffline={false} />)
    expect(container).toBeEmptyDOMElement()
  })
})
