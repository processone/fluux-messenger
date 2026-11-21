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

// The selector must compare selections and exclusions without rewriting caller values.
// Room-management callers also opt into case-insensitive roster merging and chip naming.
describe.each([false, true])('case-insensitive roster merge: %s', (caseInsensitiveRosterMerge) => {
  describe.each(['selected', 'excluded'] as const)('case-insensitive %s addresses', (kind) => {
    it.each([emma.jid, james.jid, avaJid])('does not offer or add %s under another case', (jid) => {
      const onSelectionChange = vi.fn()
      const addresses = [emma.jid, james.jid, avaJid].map(value => value.toUpperCase())
      render(
        <ContactSelector
          selectedContacts={kind === 'selected' ? addresses : []}
          excludeJids={kind === 'excluded' ? addresses : []}
          extraSuggestions={[james]}
          caseInsensitiveRosterMerge={caseInsensitiveRosterMerge}
          onSelectionChange={onSelectionChange}
        />,
      )
      const input = screen.getByRole('textbox')
      fireEvent.focus(input)
      fireEvent.change(input, { target: { value: jid.toLowerCase() } })

      expect(within(screen.getByTestId('contact-suggestions')).queryAllByRole('button')).toHaveLength(0)
      fireEvent.keyDown(input, { key: 'Enter' })
      expect(onSelectionChange).not.toHaveBeenCalled()
      if (kind === 'selected' && caseInsensitiveRosterMerge) {
        expect(screen.getByText(emma.name)).toBeInTheDocument()
        expect(screen.getByText(james.name)).toBeInTheDocument()
      } else if (kind === 'selected') {
        expect(screen.getByText(addresses[0])).toBeInTheDocument()
        expect(screen.getByText(addresses[1])).toBeInTheDocument()
      }
    })
  })
})
