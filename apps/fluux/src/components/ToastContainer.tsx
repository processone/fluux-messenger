import { useLayoutEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { RoomAvatar } from '@/components/RoomAvatar'
import { useToastStore, type ToastType } from '@/stores/toastStore'

const iconMap: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const colorMap: Record<ToastType, { border: string; icon: string }> = {
  success: { border: 'border-s-fluux-green', icon: 'text-fluux-green' },
  error: { border: 'border-s-fluux-red', icon: 'text-fluux-error' },
  info: { border: 'border-s-fluux-brand', icon: 'text-fluux-brand' },
}

const GAP_PX = 12
/** Never squeeze the stack below roughly one notice, even in a very short window. */
const MIN_STACK_PX = 72

interface StackBox {
  top: number | null
  maxHeight: number | null
}

/**
 * Where the notice stack goes: just under the main pane's header (and the
 * find-in-conversation bar when open), and no taller than the space above the
 * composer, so notices never cover what is being typed. The stack scrolls when
 * its notices do not fit. Both are null when no pane header / composer is on
 * screen (settings, empty state), which falls back to a fixed top offset.
 */
function measureStack(): StackBox {
  const header = document.querySelector('main header')
  if (!header) return { top: null, maxHeight: null }
  let bottom = header.getBoundingClientRect().bottom
  const find = document.querySelector('[data-find-on-page-bar]')
  if (find) bottom = Math.max(bottom, find.getBoundingClientRect().bottom + 8)
  // Follow the visible area when a mobile keyboard moves the visual viewport.
  const vv = window.visualViewport
  const top = Math.max(bottom + GAP_PX, (vv?.offsetTop ?? 0) + GAP_PX)
  const composer = document.querySelector('main .composer-form')
  const maxHeight = composer
    ? Math.max(MIN_STACK_PX, composer.getBoundingClientRect().top - GAP_PX - top)
    : null
  return { top, maxHeight }
}

export function ToastContainer() {
  const { t } = useTranslation()
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  const [box, setBox] = useState<StackBox>({ top: null, maxHeight: null })
  const hasToasts = toasts.length > 0

  // Notices live a few seconds, so re-measure every frame while one is shown:
  // the pane, the Find bar, the composer height and the viewport all change
  // without any event this component could subscribe to.
  useLayoutEffect(() => {
    if (!hasToasts) return
    let frame = 0
    const tick = () => {
      const next = measureStack()
      setBox((prev) => (prev.top === next.top && prev.maxHeight === next.maxHeight ? prev : next))
      frame = requestAnimationFrame(tick)
    }
    tick()
    return () => cancelAnimationFrame(frame)
  }, [hasToasts])
  const { top, maxHeight } = box

  // Arrival banners are announced politely; focus never moves.
  const announced = [...toasts].reverse().find((toast) => toast.onClick)?.message ?? ''

  return createPortal(
    <>
    <div aria-live="polite" className="sr-only">{announced}</div>
    {toasts.length > 0 && <div
      className={`fixed end-4 z-[9999] flex flex-col gap-2 overflow-y-auto overscroll-contain pointer-events-none ${top === null ? 'top-[calc(env(safe-area-inset-top)+4.5rem)]' : ''}`}
      style={top === null ? undefined : { top, maxHeight: maxHeight ?? undefined }}
      data-toast-stack
    >
      {toasts.map((toast) => {
        const Icon = iconMap[toast.type]
        const colors = colorMap[toast.type]
        const hasAction = Boolean(toast.onClick)
        return (
          <div
            key={toast.id}
            role={hasAction ? 'button' : 'status'}
            tabIndex={hasAction ? 0 : undefined}
            onClick={hasAction ? () => { toast.onClick!(); removeToast(toast.id) } : undefined}
            onKeyDown={hasAction ? (e) => { if (e.key === 'Enter' || e.key === ' ') { toast.onClick!(); removeToast(toast.id) } } : undefined}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3
                        bg-fluux-sidebar border border-fluux-border border-s-4
                        ${colors.border}
                        rounded-lg shadow-lg animate-toast-in
                        max-w-sm min-w-[280px]
                        ${hasAction ? 'cursor-pointer' : ''}`}
          >
            {toast.roomBanner ? (
              <>
                <RoomAvatar identifier={toast.roomBanner.roomJid} name={toast.roomBanner.roomName}
                  avatarUrl={toast.roomBanner.avatarUrl} size="md" className="shrink-0" />
                <div className="text-sm text-fluux-text flex-1 min-w-0 break-words">
                  <div className="font-semibold truncate">{toast.roomBanner.kind === 'message' ? toast.roomBanner.sender : toast.roomBanner.roomName}</div>
                  <div className="line-clamp-2">
                    {toast.roomBanner.kind === 'message' && <span className="text-fluux-muted">{toast.roomBanner.roomName}: </span>}
                    {toast.roomBanner.body}
                  </div>
                </div>
              </>
            ) : (
              <>
                <Icon className={`size-5 shrink-0 ${colors.icon}`} />
                <span className="text-sm text-fluux-text flex-1 line-clamp-3 break-words">{toast.message}</span>
              </>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeToast(toast.id) }}
              className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text shrink-0"
              aria-label={t('common.dismiss')}
            >
              <X className="size-4" />
            </button>
          </div>
        )
      })}
    </div>}
    </>,
    document.body
  )
}
