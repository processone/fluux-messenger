import { useCallback, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useRestoreFocus } from '@/hooks/useRestoreFocus'
import { useModalTransition } from '@/hooks/useModalTransition'

interface ConfirmDialogProps {
  title: string
  message: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  variant?: 'danger' | 'warning'
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  onConfirm,
  onCancel,
  variant = 'danger',
}: ConfirmDialogProps) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement>(null)

  // Keep keyboard focus inside the dialog across OS window blur/refocus.
  useRestoreFocus(panelRef)

  const { panelClass, scrimClass, requestClose } = useModalTransition()
  const cancel = useCallback(() => requestClose(onCancel), [requestClose, onCancel])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [cancel])

  const confirmColors = variant === 'warning'
    ? 'bg-orange-500 hover:bg-orange-600'
    : 'bg-red-500 hover:bg-red-600'

  return (
    <div
      data-modal="true"
      className={`fixed inset-0 modal-scrim flex items-center justify-center z-50 ${scrimClass}`}
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={cancel}
        className="absolute inset-0 cursor-default"
      />
      <div ref={panelRef} className={`relative z-10 fluux-glass rounded-lg p-4 max-w-sm w-full mx-4 ${panelClass}`}>
        <h3 className="text-lg font-semibold text-fluux-text mb-2">{title}</h3>
        <p className="text-sm text-fluux-muted mb-4">{message}</p>
        <div className="flex gap-2 justify-end">
          <button
            onClick={cancel}
            className="px-4 py-2 text-sm text-fluux-text bg-fluux-hover hover:bg-fluux-active
                       rounded-lg transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm text-white ${confirmColors}
                       rounded-lg transition-colors`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
