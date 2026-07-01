/**
 * Mobile-first bottom sheet: a panel that slides up from the bottom edge over a
 * dimmed backdrop. Modeled on ModalShell (shared backdrop + Escape-to-close +
 * `data-modal` contract so global keyboard handling treats it like a modal) but
 * bottom-anchored, safe-area aware, and rendered through a portal.
 *
 * The portal to `document.body` is essential: a sheet is typically triggered
 * from deep inside the message list, whose rows use `content-visibility`/paint
 * containment — which establishes a containing block that would otherwise trap a
 * `position: fixed` overlay inside the message row. Portaling escapes that.
 *
 * Used for touch action menus (e.g. per-message actions) where a centered modal
 * or a hover toolbar doesn't fit thumb ergonomics.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFocusTrap } from '@/hooks/useFocusTrap'

interface BottomSheetProps {
  /** Whether the sheet is open. Renders nothing when false. */
  open: boolean
  /** Called when the user dismisses the sheet (backdrop tap or Escape). */
  onClose: () => void
  /** Optional heading shown above the content. */
  title?: React.ReactNode
  /** Accessible label for the dialog when no visible title is provided. */
  ariaLabel?: string
  /** Extra classes for the sheet panel (e.g. a max-height). */
  panelClassName?: string
  children: React.ReactNode
}

export function BottomSheet({
  open,
  onClose,
  title,
  ariaLabel,
  panelClassName,
  children,
}: BottomSheetProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  useFocusTrap(panelRef, { active: open })

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  if (!open || typeof document === 'undefined') return null

  return createPortal(
    <div
      data-modal="true"
      className="fixed inset-0 modal-scrim flex items-end justify-center z-50"
    >
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={`relative z-10 flex max-h-[90dvh] w-full max-w-lg mx-auto flex-col fluux-glass rounded-t-2xl animate-sheet-up ${panelClassName ?? ''}`}
      >
        {/* Grab handle — affordance that the sheet is draggable/dismissable */}
        <div className="flex shrink-0 justify-center pt-2 pb-1">
          <div className="h-1 w-9 rounded-full bg-fluux-muted/40" />
        </div>
        {title && (
          <div className="shrink-0 px-4 pb-1 pt-1">
            <h2 className="text-sm font-semibold text-fluux-muted">{title}</h2>
          </div>
        )}
        {/* Scrollable content so the sheet never exceeds the viewport (landscape /
            short screens / tall emoji picker). pb-safe keeps the last row clear of
            the home indicator. */}
        <div className="min-h-0 flex-1 overflow-y-auto pb-safe">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
