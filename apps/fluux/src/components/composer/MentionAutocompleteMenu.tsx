import { useTranslation } from 'react-i18next'
import { Users } from 'lucide-react'
import { Avatar } from '../Avatar'
import { autocompleteOptionId } from './autocompleteAria'
import type { MentionMatch } from '../../hooks/useMentionAutocomplete'

interface MentionAutocompleteMenuProps {
  id: string
  matches: MentionMatch[]
  selectedIndex: number
  onSelect: (index: number) => void
}

/**
 * Occupant completion dropdown rendered above the room composer input.
 * Mirrors the inline emoji completion popover so both announce themselves the
 * same way — see [autocompleteAria] for the shared listbox contract.
 */
export function MentionAutocompleteMenu({
  id,
  matches,
  selectedIndex,
  onSelect,
}: MentionAutocompleteMenuProps) {
  const { t } = useTranslation()

  if (matches.length === 0) return null

  return (
    <div
      id={id}
      role="listbox"
      aria-label={t('rooms.mentionSuggestions')}
      className="absolute bottom-full inset-x-0 mb-1 max-h-48 overflow-y-auto
                 fluux-popover rounded-lg z-30"
    >
      {matches.map((match, idx) => (
        <button
          key={match.nick}
          id={autocompleteOptionId(id, match.nick)}
          type="button"
          role="option"
          aria-selected={idx === selectedIndex}
          tabIndex={-1}
          onClick={() => onSelect(idx)}
          className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 transition-colors
                     ${idx === selectedIndex
                       ? 'bg-fluux-brand text-fluux-text-on-accent'
                       : 'hover:bg-fluux-hover text-fluux-text'}`}
        >
          {/* Avatar */}
          {match.isAll ? (
            <div className="size-6 rounded-full flex items-center justify-center flex-shrink-0 bg-fluux-brand">
              <Users className="size-3.5 text-fluux-text-on-accent" />
            </div>
          ) : (
            <Avatar
              identifier={match.nick}
              name={match.nick}
              size="xs"
            />
          )}
          <span className="font-medium">@{match.nick}</span>
          {match.isAll && (
            <span className={`text-xs ${idx === selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'}`}>
              {t('rooms.notifyEveryone')}
            </span>
          )}
          {match.role === 'moderator' && !match.isAll && (
            <span className={`text-xs ${idx === selectedIndex ? 'text-fluux-text-on-accent/70' : 'text-fluux-muted'}`}>
              {t('rooms.mod')}
            </span>
          )}
        </button>
      ))}
    </div>
  )
}
