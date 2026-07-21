import type React from 'react'

/**
 * ARIA attributes the composer textarea carries while it drives a listbox popup.
 * Shared so every overlay that owns the composer announces itself the same way.
 */
export type ComposerAutocompleteAriaProps = Pick<
  React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  'role' | 'aria-label' | 'aria-autocomplete' | 'aria-expanded' | 'aria-controls' | 'aria-activedescendant'
>

/** Stable DOM id for an autocomplete option, referenced by `aria-activedescendant`. */
export function autocompleteOptionId(listboxId: string, optionKey: string): string {
  return `${listboxId}-option-${encodeURIComponent(optionKey)}`
}

/**
 * Wire a composer textarea to whichever completion popup currently owns it.
 *
 * The `combobox` role stays on the textarea even while closed — screen readers
 * do not reliably pick up a role that appears and disappears — so the open state
 * is carried by `aria-expanded` instead. Each overlay owner (emoji completion in
 * the composer, mention completion in a room) builds its own props, which is what
 * keeps the announced popup and the visible popup the same one.
 */
export function composerAutocompleteAriaProps({
  label,
  listboxId,
  isOpen,
  activeOptionKey,
}: {
  label: string
  listboxId: string
  isOpen: boolean
  activeOptionKey?: string
}): ComposerAutocompleteAriaProps {
  return {
    role: 'combobox',
    'aria-label': label,
    'aria-autocomplete': 'list',
    'aria-expanded': isOpen,
    'aria-controls': isOpen ? listboxId : undefined,
    'aria-activedescendant':
      isOpen && activeOptionKey !== undefined
        ? autocompleteOptionId(listboxId, activeOptionKey)
        : undefined,
  }
}
