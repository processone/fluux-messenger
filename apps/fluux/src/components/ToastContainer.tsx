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

/**
 * Top of the notice stack: just under the main pane's header (and the
 * find-in-conversation bar when open), so notices never cover the composer.
 * Returns null while no pane header is on screen (settings, empty state).
 */
function measureStackTop(): number | null {
  const header = document.querySelector('main header')
  if (!header) return null
  let bottom = header.getBoundingClientRect().bottom
  const find = document.querySelector('[data-find-on-page-bar]')
  if (find) bottom = Math.max(bottom, find.getBoundingClientRect().bottom + 8)
  return bottom + GAP_PX
}

export function ToastContainer() {
  const { t } = useTranslation()
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  const [top, setTop] = useState<number | null>(null)
  const hasToasts = toasts.length > 0

  useLayoutEffect(() => {
    if (!hasToasts) return
    const update = () => setTop(measureStackTop())
    update()
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [hasToasts, toasts.length])

  // Arrival banners are announced politely; focus never moves.
  const announced = [...toasts].reverse().find((toast) => toast.onClick)?.message ?? ''

  return createPortal(
    <>
    <div aria-live="polite" className="sr-only">{announced}</div>
    {toasts.length > 0 && <div
      className={`fixed end-4 z-[9999] flex flex-col gap-2 pointer-events-none ${top === null ? 'top-[calc(env(safe-area-inset-top)+4.5rem)]' : ''}`}
      style={top === null ? undefined : { top }}
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
