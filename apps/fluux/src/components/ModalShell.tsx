import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import { useModalTransition } from '@/hooks/useModalTransition'

interface ModalShellProps {
  title: React.ReactNode
  onClose: () => void
  /** Tailwind width class for the panel, e.g. 'max-w-sm' (default), 'max-w-md', 'w-80' */
  width?: string
  /** Extra classes on the panel div, e.g. 'max-h-[80vh]' */
  panelClassName?: string
  children: React.ReactNode
}

export function ModalShell({
  title,
  onClose,
  width = 'max-w-sm',
  panelClassName,
  children,
}: ModalShellProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)
  const { panelClass, scrimClass, requestClose } = useModalTransition()
  const close = useCallback(() => requestClose(onClose), [requestClose, onClose])

  // Keep keyboard focus inside the modal across OS window blur/refocus, so
  // global shortcuts don't reclaim arrow/Tab keys when the user switches away
  // and back. See useRestoreFocus for the full rationale.
  useRestoreFocus(panelRef)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [close])

  return (
    <div
      data-modal="true"
      className={`fixed inset-0 modal-scrim flex items-center justify-center z-50 ${scrimClass}`}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default"
      />
      <div ref={panelRef} className={`relative z-10 fluux-glass rounded-lg w-full ${width} mx-4 ${panelClass} ${panelClassName ?? ''}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <h2 className="text-lg font-semibold text-fluux-text">{title}</h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={close}
              aria-label={t('common.close')}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover tap-target"
            >
              <X className="size-4" />
            </button>
          </Tooltip>
        </div>

        {children}
      </div>
    </div>
  )
}
