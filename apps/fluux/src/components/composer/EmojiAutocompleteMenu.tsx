import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { autocompleteOptionId } from './autocompleteAria'
import type { EmojiMatch } from '../../hooks/useEmojiAutocomplete'

interface EmojiAutocompleteMenuProps {
  id: string
  matches: EmojiMatch[]
  selectedIndex: number
  onSelect: (index: number) => void
  onDismiss: () => void
}

/**
 * Inline emoji completion dropdown popover rendered above the message composer input field.
 */
export function EmojiAutocompleteMenu({ id, matches, selectedIndex, onSelect, onDismiss }: EmojiAutocompleteMenuProps) {
  const { t } = useTranslation()
  const selectedRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard-highlighted item visible as selection moves past the popover edges.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Dismiss on a pointer press anywhere outside the popover.
  useEffect(() => {
    const handlePointerDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) {
        onDismiss()
      }
    }
    document.addEventListener('pointerdown', handlePointerDown, true)
    return () => document.removeEventListener('pointerdown', handlePointerDown, true)
  }, [onDismiss])

  if (matches.length === 0) return null

  return (
    <div
      id={id}
      ref={menuRef}
      role="listbox"
      aria-label={t('chat.emojiSuggestions')}
      className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto fluux-popover rounded-lg z-30 flex flex-col"
    >
      {matches.map((match, idx) => (
        <button
          key={match.id}
          id={autocompleteOptionId(id, match.id)}
          ref={idx === selectedIndex ? selectedRef : undefined}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          tabIndex={-1}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(idx)}
          className={`w-full px-3 py-2 text-start text-sm flex items-center gap-3 transition-colors ${
            idx === selectedIndex
              ? 'bg-fluux-brand text-fluux-text-on-accent'
              : 'hover:bg-fluux-hover text-fluux-text'
          }`}
        >
          <span className="text-lg leading-none" aria-hidden="true">
            {match.native}
          </span>
          <span className="font-mono text-xs font-semibold">:{match.id}:</span>
          <span
            className={`text-xs truncate ${
              idx === selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'
            }`}
          >
            {match.name}
          </span>
        </button>
      ))}
    </div>
  )
}
