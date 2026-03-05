import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'

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

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  return (
    <div
      data-modal="true"
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className={`bg-fluux-sidebar rounded-lg shadow-xl w-full ${width} mx-4 ${panelClassName ?? ''}`}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
          <h2 className="text-lg font-semibold text-fluux-text">{title}</h2>
          <Tooltip content={t('common.close')}>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        {children}
      </div>
    </div>
  )
}
