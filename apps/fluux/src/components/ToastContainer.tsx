import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
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

export function ToastContainer() {
  const { t } = useTranslation()
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="fixed bottom-4 end-4 z-[9999] flex flex-col gap-2 pointer-events-none">
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
            <Icon className={`size-5 shrink-0 ${colors.icon}`} />
            <span className="text-sm text-fluux-text flex-1">{toast.message}</span>
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
    </div>,
    document.body
  )
}
