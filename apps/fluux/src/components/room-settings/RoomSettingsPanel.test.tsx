import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import type { DataForm, Room } from '@fluux/sdk'
import { RoomSettingsPanel } from './RoomSettingsPanel'

// jsdom's matchMedia (test-setup) never matches, so the panel renders its mobile list-then-section layout.
const room = { jid: 'team@conference.example.com', name: 'Team', subject: 'Plans', occupants: new Map() } as unknown as Room

const form: DataForm = {
  type: 'form',
  fields: [
    { var: 'FORM_TYPE', type: 'hidden', value: 'http://jabber.org/protocol/muc#roomconfig' },
    { var: 'muc#roomconfig_roomname', type: 'text-single', value: 'Team' },
    { var: 'muc#roomconfig_passwordprotectedroom', type: 'boolean', value: '0' },
    { var: 'muc#roomconfig_roomsecret', type: 'text-private', value: 'kept' },
    { var: 'muc#roomconfig_whois', type: 'list-single', value: 'moderators', options: [{ value: 'moderators', label: 'moderators only' }, { value: 'anyone', label: 'anyone' }] },
    { var: 'x_vendor_option', type: 'text-single', label: 'Vendor option', value: 'v' },
  ],
}

function setup() {
  const onSave = vi.fn()
  render(
    <RoomSettingsPanel room={room} form={form} subject="Plans" onSubjectChange={() => {}} onSave={onSave}
      onClose={() => {}} saving={false} saveError={null} isOwner={false} onDestroyClick={() => {}} />,
  )
  const openSection = (id: string) => fireEvent.click(document.querySelector(`[data-rs-section="${id}"]`)!)
  return { onSave, openSection }
}

describe('RoomSettingsPanel', () => {
  it('hides a dependent field while its switch is off but still submits it, with every other value', () => {
    const { onSave, openSection } = setup()
    openSection('access')
    expect(document.getElementById('rs-muc#roomconfig_roomsecret')).toBeNull()

    // Segmented control: End jumps to the last option.
    const moderatorsOnly = screen.getByRole('radio', { name: 'Moderators only' })
    fireEvent.keyDown(moderatorsOnly, { key: 'End' })
    expect(screen.getByRole('radio', { name: 'Anyone' })).toHaveAttribute('aria-checked', 'true')

    fireEvent.click(screen.getByText('rooms.saveSettings'))
    expect(onSave).toHaveBeenCalledWith({
      FORM_TYPE: 'http://jabber.org/protocol/muc#roomconfig',
      'muc#roomconfig_roomname': 'Team',
      'muc#roomconfig_passwordprotectedroom': '0',
      'muc#roomconfig_roomsecret': 'kept',
      'muc#roomconfig_whois': 'anyone',
      x_vendor_option: 'v',
    })
  })

  it('shows the dependent field once its switch is on, and marks the edited section unsaved', () => {
    const { openSection } = setup()
    openSection('access')
    fireEvent.click(document.getElementById('rs-muc#roomconfig_passwordprotectedroom')!)
    expect(document.getElementById('rs-muc#roomconfig_roomsecret')).not.toBeNull()

    fireEvent.click(screen.getByText('Back'))
    const row = document.querySelector('[data-rs-section="access"]')!
    expect(row).toHaveFocus()
    expect(row).toHaveTextContent('rooms.settings.unsaved')
    expect(document.querySelector('[data-rs-section="general"]')).not.toHaveTextContent('rooms.settings.unsaved')
  })

  it('moves focus to the section heading when a section opens, and lists unknown vars under Advanced', () => {
    const { openSection } = setup()
    openSection('advanced')
    expect(screen.getByRole('heading', { level: 3 })).toHaveFocus()
    expect(screen.getByLabelText('Vendor option')).toHaveValue('v')
  })
})
