import { useTranslation } from 'react-i18next'
import { Monitor } from 'lucide-react'

interface TabBlockedScreenProps {
  /** True when this tab was kicked by another tab taking over */
  takenOver: boolean
  /** Called when user clicks "Use here instead" or "Reconnect here" */
  onTakeOver: () => void
}

export function TabBlockedScreen({ takenOver, onTakeOver }: TabBlockedScreenProps) {
  const { t } = useTranslation()

  return (
    <div className="h-full bg-fluux-bg flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <div className="mb-8">
          <img
            src="/logo.png"
            alt={t('login.title')}
            className="w-16 h-16 mx-auto mb-4 opacity-50"
          />
        </div>

        <div className="bg-fluux-sidebar rounded-lg p-8 space-y-4">
          <Monitor className="w-10 h-10 mx-auto text-fluux-muted" />

          <h2 className="text-lg font-semibold text-fluux-text">
            {takenOver
              ? t('tabCoordination.takenOver')
              : t('tabCoordination.alreadyOpen')}
          </h2>

          <p className="text-sm text-fluux-muted">
            {takenOver
              ? t('tabCoordination.takenOverDescription')
              : t('tabCoordination.alreadyOpenDescription')}
          </p>

          <button
            onClick={onTakeOver}
            className="w-full py-2.5 bg-fluux-brand hover:bg-fluux-brand-hover
                       text-white font-medium rounded transition-colors
                       focus-visible:ring-2 focus-visible:ring-fluux-brand focus-visible:ring-offset-2 focus-visible:ring-offset-fluux-sidebar"
          >
            {takenOver
              ? t('tabCoordination.reconnectHere')
              : t('tabCoordination.useHere')}
          </button>
        </div>
      </div>
    </div>
  )
}
