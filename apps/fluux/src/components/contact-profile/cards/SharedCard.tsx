import { useTranslation } from 'react-i18next'

interface SharedCardProps {
  groups: string[] | undefined
  isInRoster: boolean
}

export function SharedCard({ groups, isInRoster }: SharedCardProps) {
  const { t } = useTranslation()
  if (!isInRoster || !groups || groups.length === 0) return null

  return (
    <section className="rounded-xl border border-fluux-hover bg-fluux-bg/40 p-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-2 px-1">
        {t('contacts.shared')}
      </h3>
      <div className="flex flex-wrap gap-2">
        {groups.map((group) => (
          <span
            key={group}
            className="px-2 py-0.5 text-xs rounded-full bg-fluux-bg text-fluux-text border border-fluux-hover"
          >
            {group}
          </span>
        ))}
      </div>
    </section>
  )
}
