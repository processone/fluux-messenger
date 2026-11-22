import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** Informational only: never a keyboard option or part of the selection indexes. */
export function SuggestionLimitHint({ shown, total }: { shown: number; total: number }) {
  const { t } = useTranslation()
  const text = shown < total ? t('common.suggestionLimit', { shown, total }) : ''
  const [announcement, setAnnouncement] = useState('')
  // Mount an empty live region first, then update it. Initially populated status
  // regions are not reliably announced when a suggestion popover opens.
  useEffect(() => { setAnnouncement(text) }, [text])
  if (!text) return null
  return (
    <>
      <p aria-hidden="true" className="px-3 py-1.5 text-xs text-fluux-muted" data-suggestion-limit>
        {text}
      </p>
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </span>
    </>
  )
}
