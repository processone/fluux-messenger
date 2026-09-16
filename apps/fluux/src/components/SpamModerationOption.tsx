import { useId } from 'react'
import { useTranslation } from 'react-i18next'

/** Keep the wire reason stable even when the moderator uses a translated UI. */
export function SpamModerationOption({ reason, onChange }: { reason: string; onChange: (reason: string) => void }) {
  const { t } = useTranslation()
  const hintId = useId()
  const selected = reason.trim().toLowerCase() === 'spam'
  return (
    <div className="space-y-1.5">
      <label className={`flex items-start gap-2 px-3 py-2 rounded-lg border text-sm cursor-pointer ${selected
        ? 'border-fluux-brand bg-fluux-selection text-fluux-text'
        : 'border-fluux-border text-fluux-text hover:bg-fluux-hover'}`}>
        <input type="checkbox" checked={selected} aria-describedby={hintId}
          onChange={event => onChange(event.target.checked ? 'Spam' : '')}
          className="mt-0.5 size-4 shrink-0 accent-fluux-brand" />
        <span>{t('rooms.moderationSpam')}</span>
      </label>
      <p id={hintId} className="text-xs text-fluux-muted">{t('rooms.moderationSpamHint')}</p>
    </div>
  )
}
