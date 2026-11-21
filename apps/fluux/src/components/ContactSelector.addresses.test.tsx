import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { Contact } from '@fluux/sdk'
import { ContactSelector } from './ContactSelector'

// Real demo identities, with case variants exercising the room-picker review finding.
const emma: Contact = { jid: 'Emma@fluux.chat', name: 'Emma Wilson', presence: 'online', subscription: 'both' }
const james = { jid: 'James@fluux.chat', name: 'James' }
const avaJid = 'Ava@fluux.chat'

vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@fluux/sdk')>()),
  useRoster: () => ({ contacts: [emma] }),
}))

// The selector must compare identities without rewriting the values held by callers.
// This file owns selected-address and typed-address case matching; the modal suite
// owns the roster/suggestion merge, loaded room exclusions and submitted addresses.
describe.each(['selected', 'excluded'] as const)('case-insensitive %s addresses', (kind) => {
  it.each([emma.jid, james.jid, avaJid])('does not offer or add %s under another case', (jid) => {
    const onSelectionChange = vi.fn()
    const addresses = [emma.jid, james.jid, avaJid].map(value => value.toUpperCase())
    render(
      <ContactSelector
        selectedContacts={kind === 'selected' ? addresses : []}
        excludeJids={kind === 'excluded' ? addresses : []}
        extraSuggestions={[james]}
        onSelectionChange={onSelectionChange}
      />,
    )
    const input = screen.getByRole('textbox')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: jid.toLowerCase() } })

    expect(within(screen.getByTestId('contact-suggestions')).queryAllByRole('button')).toHaveLength(0)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onSelectionChange).not.toHaveBeenCalled()
    if (kind === 'selected') {
      expect(screen.getByText(emma.name)).toBeInTheDocument()
      expect(screen.getByText(james.name)).toBeInTheDocument()
    }
  })
})
