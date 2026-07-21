import { describe, expect, it } from 'vitest'
import { autocompleteOptionId, composerAutocompleteAriaProps } from './autocompleteAria'

describe('autocompleteOptionId', () => {
  it('namespaces the option under its listbox', () => {
    expect(autocompleteOptionId('list-1', 'heart')).toBe('list-1-option-heart')
  })

  it('escapes keys that are not safe in a DOM id', () => {
    expect(autocompleteOptionId('list-1', '+1')).toBe('list-1-option-%2B1')
    expect(autocompleteOptionId('list-1', 'Ana María')).toBe('list-1-option-Ana%20Mar%C3%ADa')
  })
})

describe('composerAutocompleteAriaProps', () => {
  const base = { label: 'Send to Ava', listboxId: 'list-1' }

  it('keeps the combobox role and drops the popup wiring while closed', () => {
    expect(composerAutocompleteAriaProps({ ...base, isOpen: false, activeOptionKey: 'heart' })).toEqual({
      role: 'combobox',
      'aria-label': 'Send to Ava',
      'aria-autocomplete': 'list',
      'aria-expanded': false,
      'aria-controls': undefined,
      'aria-activedescendant': undefined,
    })
  })

  it('points at the listbox and the active option while open', () => {
    expect(composerAutocompleteAriaProps({ ...base, isOpen: true, activeOptionKey: 'heart' })).toEqual({
      role: 'combobox',
      'aria-label': 'Send to Ava',
      'aria-autocomplete': 'list',
      'aria-expanded': true,
      'aria-controls': 'list-1',
      'aria-activedescendant': 'list-1-option-heart',
    })
  })

  it('still exposes the listbox when no option is active yet', () => {
    expect(composerAutocompleteAriaProps({ ...base, isOpen: true })).toMatchObject({
      'aria-expanded': true,
      'aria-controls': 'list-1',
      'aria-activedescendant': undefined,
    })
  })
})
