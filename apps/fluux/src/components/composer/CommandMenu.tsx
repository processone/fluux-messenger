import { useTranslation } from 'react-i18next'
import type { SlashCommand } from '../../commands/types'

interface CommandMenuProps {
  matches: SlashCommand[]
  selectedIndex: number
  onSelect: (index: number) => void
}

/** Command-name completion popover, rendered through MessageComposer's `aboveInput` slot. */
export function CommandMenu({ matches, selectedIndex, onSelect }: CommandMenuProps) {
  const { t } = useTranslation()
  if (matches.length === 0) return null
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto fluux-popover rounded-lg z-30">
      {matches.map((cmd, idx) => (
        <button
          key={cmd.name}
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
