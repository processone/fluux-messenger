import { useTranslation } from 'react-i18next'
import { X } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ModalOverlay } from './ModalOverlay'

interface ModalShellProps {
  title: React.ReactNode
  onClose: () => void
  /** Tailwind width class for the panel, e.g. 'max-w-sm' (default), 'max-w-md', 'w-80' */
  width?: string
  /** Extra classes on the panel div, e.g. 'max-h-[80vh]' */
  panelClassName?: string
  children: React.ReactNode
}

/**
 * Standard titled modal: a {@link ModalOverlay} (glass panel + scrim + transition
 * + focus restore + Escape) with a header carrying the title and a close button.
 * Use this for the common case; reach for ModalOverlay directly only when the
 * header is bespoke (e.g. the verify-peer dialog).
 */
export function ModalShell({
  title,
  onClose,
  width = 'max-w-sm',
  panelClassName,
  children,
}: ModalShellProps) {
  const { t } = useTranslation()

  return (
    <ModalOverlay onClose={onClose} width={width} panelClassName={panelClassName}>
      {({ close }) => (
        <>
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover flex-shrink-0">
            <h2 className="text-lg font-semibold text-fluux-text">{title}</h2>
            <Tooltip content={t('common.close')}>
              <button
                onClick={close}
                aria-label={t('common.close')}
                // Escape closes the modal, so the X is a pointer-only affordance:
                // kept out of the tab order (and thus the focus trap's initial
                // target) so opening a modal never lands focus here — which would
                // otherwise draw the focus ring and pop this tooltip unprompted.
                tabIndex={-1}
                className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover tap-target"
              >
                <X className="size-4" />
              </button>
            </Tooltip>
          </div>

          {children}
        </>
      )}
    </ModalOverlay>
  )
}
