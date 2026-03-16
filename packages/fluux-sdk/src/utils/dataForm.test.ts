/**
 * Data Form Utility Tests
 *
 * Tests for XEP-0004 Data Form utilities including parsing and building.
 */
import { describe, it, expect } from 'vitest'
import { buildDataFormSubmit } from './dataForm'

describe('buildDataFormSubmit', () => {
  it('builds a submit form with single values', () => {
    const result = buildDataFormSubmit({
      'muc#roomconfig_roomname': 'Test Room',
      'muc#roomconfig_persistentroom': '1',
    })

    expect(result.attrs.xmlns).toBe('jabber:x:data')
    expect(result.attrs.type).toBe('submit')

    const fields = result.getChildren('field')
    expect(fields).toHaveLength(2)

    const nameField = fields.find(f => f.attrs.var === 'muc#roomconfig_roomname')
    expect(nameField).toBeDefined()
    expect(nameField!.getChildText('value')).toBe('Test Room')

    const persistField = fields.find(f => f.attrs.var === 'muc#roomconfig_persistentroom')
    expect(persistField).toBeDefined()
    expect(persistField!.getChildText('value')).toBe('1')
  })

  it('builds a submit form with array values', () => {
    const result = buildDataFormSubmit({
      'muc#roomconfig_roomadmins': ['admin1@example.com', 'admin2@example.com'],
    })

    const field = result.getChildren('field').find(f => f.attrs.var === 'muc#roomconfig_roomadmins')
    expect(field).toBeDefined()

    const values = field!.getChildren('value')
    expect(values).toHaveLength(2)
    expect(values[0].text()).toBe('admin1@example.com')
    expect(values[1].text()).toBe('admin2@example.com')
  })

  it('adds FORM_TYPE as hidden field when specified', () => {
    const result = buildDataFormSubmit(
      { 'muc#roomconfig_roomname': 'Test' },
      'http://jabber.org/protocol/muc#roomconfig'
    )

    const fields = result.getChildren('field')
    const formTypeField = fields.find(f => f.attrs.var === 'FORM_TYPE')

    expect(formTypeField).toBeDefined()
    expect(formTypeField!.attrs.type).toBe('hidden')
    expect(formTypeField!.getChildText('value')).toBe('http://jabber.org/protocol/muc#roomconfig')
  })

  it('does not duplicate FORM_TYPE if present in values', () => {
    const result = buildDataFormSubmit(
      {
        'FORM_TYPE': 'should-be-ignored',
        'muc#roomconfig_roomname': 'Test',
      },
      'http://jabber.org/protocol/muc#roomconfig'
    )

    const formTypeFields = result.getChildren('field').filter(f => f.attrs.var === 'FORM_TYPE')
    expect(formTypeFields).toHaveLength(1)
    expect(formTypeFields[0].getChildText('value')).toBe('http://jabber.org/protocol/muc#roomconfig')
  })

  it('handles empty values', () => {
    const result = buildDataFormSubmit({
      'muc#roomconfig_roomdesc': '',
    })

    const field = result.getChildren('field').find(f => f.attrs.var === 'muc#roomconfig_roomdesc')
    expect(field).toBeDefined()
    expect(field!.getChildText('value')).toBe('')
  })

  it('handles empty array values', () => {
    const result = buildDataFormSubmit({
      'muc#roomconfig_roomadmins': [],
    })

    const field = result.getChildren('field').find(f => f.attrs.var === 'muc#roomconfig_roomadmins')
    expect(field).toBeDefined()
    expect(field!.getChildren('value')).toHaveLength(0)
  })

  it('builds form without FORM_TYPE when not specified', () => {
    const result = buildDataFormSubmit({
      'muc#roomconfig_roomname': 'Test',
    })

    const formTypeField = result.getChildren('field').find(f => f.attrs.var === 'FORM_TYPE')
    expect(formTypeField).toBeUndefined()
  })
})
