import { useTranslation } from 'react-i18next'

/** Keep the wire reason stable even when the moderator uses a translated UI. */
export function SpamModerationOption({ reason, onChange }: { reason: string; onChange: (reason: string) => void }) {
  const { t } = useTranslation()
  const selected = reason.trim().toLowerCase() === 'spam'
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onChange(selected ? '' : 'Spam')}
      className={`px-3 py-2 rounded-lg border text-sm text-start ${selected
        ? 'border-fluux-brand bg-fluux-brand/10 text-fluux-brand'
        : 'border-fluux-border text-fluux-muted hover:bg-fluux-hover'}`}
    >
      {t('rooms.moderationSpam')}
    </button>
  )
}
