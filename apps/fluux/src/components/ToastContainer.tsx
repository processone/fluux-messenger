import { createPortal } from 'react-dom'
import { X, CheckCircle2, AlertCircle, Info } from 'lucide-react'
import { useToastStore, type ToastType } from '@/stores/toastStore'

const iconMap: Record<ToastType, typeof CheckCircle2> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const colorMap: Record<ToastType, { border: string; icon: string }> = {
  success: { border: 'border-l-fluux-green', icon: 'text-fluux-green' },
  error: { border: 'border-l-fluux-red', icon: 'text-fluux-red' },
  info: { border: 'border-l-fluux-brand', icon: 'text-fluux-brand' },
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  if (toasts.length === 0) return null

  return createPortal(
    <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
      {toasts.map((toast) => {
        const Icon = iconMap[toast.type]
        const colors = colorMap[toast.type]
        return (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3
                        bg-fluux-sidebar border border-fluux-border border-l-4
                        ${colors.border}
                        rounded-lg shadow-lg animate-toast-in
                        max-w-sm min-w-[280px]`}
          >
            <Icon className={`w-5 h-5 shrink-0 ${colors.icon}`} />
            <span className="text-sm text-fluux-text flex-1">{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              className="p-0.5 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text shrink-0"
              aria-label="Dismiss"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )
      })}
    </div>,
    document.body
  )
}
