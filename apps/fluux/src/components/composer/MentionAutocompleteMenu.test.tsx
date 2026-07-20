import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MentionAutocompleteMenu } from './MentionAutocompleteMenu'
import { autocompleteOptionId } from './autocompleteAria'
import type { MentionMatch } from '../../hooks/useMentionAutocomplete'

const MATCHES: MentionMatch[] = [
  { nick: 'all', isAll: true },
  { nick: 'ava', isAll: false, role: 'moderator' },
  { nick: 'bo', isAll: false, role: 'participant' },
]

function renderMenu(selectedIndex = 0, onSelect = vi.fn()) {
  render(
    <MentionAutocompleteMenu
      id="mentions"
      matches={MATCHES}
      selectedIndex={selectedIndex}
      onSelect={onSelect}
    />
  )
  return onSelect
}

describe('MentionAutocompleteMenu', () => {
  it('exposes the suggestions as a named listbox', () => {
    renderMenu()

    // t() falls through to the key for anything outside the test i18n subset.
    expect(screen.getByRole('listbox', { name: 'rooms.mentionSuggestions' })).toBeInTheDocument()
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('marks only the selected option and gives it a referable id', () => {
    renderMenu(1)

    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
    ])
    expect(options[1]).toHaveAttribute('id', autocompleteOptionId('mentions', 'ava'))
  })

  it('reports the index of a clicked option', () => {
    const onSelect = renderMenu(0)

    fireEvent.click(screen.getAllByRole('option')[2])

    expect(onSelect).toHaveBeenCalledWith(2)
  })

  it('renders nothing when there is nothing to suggest', () => {
    const { container } = render(
      <MentionAutocompleteMenu id="mentions" matches={[]} selectedIndex={0} onSelect={vi.fn()} />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
