import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'

interface MentionChipProps {
  label: string
  actionLabel: string
  onAction: () => void
  onDismiss: () => void
  icon?: ReactNode
}

/** Shared pill used above the composer for transient conversation notices (reaction mentions, easter eggs). */
export function MentionChip({ label, actionLabel, onAction, onDismiss, icon }: MentionChipProps) {
  const { t } = useTranslation()
  return (
    <div className="mx-auto max-w-md flex items-center justify-center gap-2 text-xs text-fluux-muted bg-fluux-hover/60 rounded-full px-3 py-1">
      {icon}
      <span className="truncate">{label}</span>
      <button type="button" onClick={onAction} className="font-medium text-fluux-brand hover:underline flex-shrink-0">
        {actionLabel}
      </button>
      <button type="button" onClick={onDismiss} aria-label={t('common.dismiss')} className="text-fluux-muted hover:text-fluux-text flex-shrink-0">
        <X className="size-3" />
      </button>
    </div>
  )
}
