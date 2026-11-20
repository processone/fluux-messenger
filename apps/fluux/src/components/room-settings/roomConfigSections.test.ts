import { describe, it, expect } from 'vitest'
import type { DataFormField } from '@fluux/sdk'
import { groupFields } from './roomConfigSections'

const f = (v: string, type: DataFormField['type'] = 'boolean', value: string | string[] = '0'): DataFormField =>
  ({ var: v, type, value, label: v })

describe('groupFields', () => {
  it('places known vars in their section and group, in display order', () => {
    const groups = groupFields([
      f('muc#roomconfig_persistentroom'),
      f('muc#roomconfig_roomname', 'text-single', 'Team'),
      f('muc#roomconfig_publicroom'),
    ])
    expect(groups.get('general')?.map(g => g.id)).toEqual(['identity'])
    const visibility = groups.get('access')?.find(g => g.id === 'visibility')
    expect(visibility?.fields.map(p => p.field.var)).toEqual(['muc#roomconfig_publicroom', 'muc#roomconfig_persistentroom'])
    expect(visibility?.fields[0].labelKey).toBe('publicRoom')
  })

  it('puts unknown vars last in Advanced > Other, with no label key, and drops hidden fields', () => {
    const groups = groupFields([
      f('FORM_TYPE', 'hidden', 'http://jabber.org/protocol/muc#roomconfig'),
      f('x_vendor_option', 'text-single', 'a'),
      f('mam'),
    ])
    expect(groups.get('advanced')?.map(g => g.id)).toEqual(['history', 'other'])
    const other = groups.get('advanced')?.find(g => g.id === 'other')
    expect(other?.fields).toEqual([{ field: expect.objectContaining({ var: 'x_vendor_option' }) }])
    expect([...groups.values()].flat().flatMap(g => g.fields).some(p => p.field.var === 'FORM_TYPE')).toBe(false)
  })

  it('marks dependent fields with the switch they depend on', () => {
    const joining = groupFields([
      f('muc#roomconfig_passwordprotectedroom'),
      f('muc#roomconfig_roomsecret', 'text-private', ''),
    ]).get('access')?.find(g => g.id === 'joining')
    expect(joining?.fields.find(p => p.field.var === 'muc#roomconfig_roomsecret')?.dependsOn)
      .toBe('muc#roomconfig_passwordprotectedroom')
  })
})
