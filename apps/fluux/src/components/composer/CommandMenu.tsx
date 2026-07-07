import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { SlashCommand } from '../../commands/types'

interface CommandMenuProps {
  matches: SlashCommand[]
  selectedIndex: number
  onSelect: (index: number) => void
  /** Dismiss the menu (e.g. a pointer press outside the popover). */
  onDismiss: () => void
}

/** Command-name completion popover, rendered through MessageComposer's `aboveInput` slot. */
export function CommandMenu({ matches, selectedIndex, onSelect, onDismiss }: CommandMenuProps) {
  const { t } = useTranslation()
  const selectedRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Keep the keyboard-highlighted item visible as selection moves past the popover edges.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Dismiss on a pointer press anywhere outside the popover. A press on the
  // composer's own textarea moves the caret, which already closes the menu via
  // the match check, so we only need to guard the menu's own subtree here.
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
      ref={menuRef}
      className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto fluux-popover rounded-lg z-30"
    >
      {matches.map((cmd, idx) => (
        <button
          key={cmd.name}
          ref={idx === selectedIndex ? selectedRef : undefined}
          type="button"
          onClick={() => onSelect(idx)}
          className={`w-full px-3 py-2 text-start text-sm flex items-baseline gap-2 transition-colors ${
            idx === selectedIndex
              ? 'bg-fluux-brand text-fluux-text-on-accent'
              : 'hover:bg-fluux-hover text-fluux-text'
          }`}
        >
          <span className="font-medium">/{cmd.name}</span>
          <span
            className={`text-xs ${
              idx === selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'
            }`}
          >
            {t(cmd.descriptionKey)}
          </span>
        </button>
      ))}
    </div>
  )
}
