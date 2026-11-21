import { useTranslation } from 'react-i18next'

/** Informational only: never a keyboard option or part of the selection indexes. */
export function SuggestionLimitHint({ shown, total }: { shown: number; total: number }) {
  const { t } = useTranslation()
  if (shown >= total) return null
  return (
    <p className="px-3 py-1.5 text-xs text-fluux-muted" data-suggestion-limit>
      {t('common.suggestionLimit', { shown, total })}
    </p>
  )
}
