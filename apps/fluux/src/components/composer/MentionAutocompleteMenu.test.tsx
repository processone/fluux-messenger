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

  // The popover is capped at max-h-48 and scrolls, so a selection driven past
  // the visible edge by the arrow keys has to be brought back into view.
  it('keeps the newly selected option in view', () => {
    const scrollIntoView = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(scrollIntoView)

    const { rerender } = render(
      <MentionAutocompleteMenu id="mentions" matches={MATCHES} selectedIndex={0} onSelect={vi.fn()} />
    )
    scrollIntoView.mockClear()

    rerender(
      <MentionAutocompleteMenu id="mentions" matches={MATCHES} selectedIndex={2} onSelect={vi.fn()} />
    )

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' })
    expect(scrollIntoView.mock.instances[0]).toBe(screen.getAllByRole('option')[2])
  })

  // Pressing an option must not blur the textarea, or the caret the completion
  // is about to rewrite is gone by the time the click lands.
  it('does not steal focus from the composer when an option is pressed', () => {
    renderMenu()

    const notPrevented = fireEvent.mouseDown(screen.getAllByRole('option')[1])

    expect(notPrevented).toBe(false)
  })

  it('renders nothing when there is nothing to suggest', () => {
    const { container } = render(
      <MentionAutocompleteMenu id="mentions" matches={[]} selectedIndex={0} onSelect={vi.fn()} />
    )

    expect(container).toBeEmptyDOMElement()
  })
})
