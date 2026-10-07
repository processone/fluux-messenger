import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, ChevronRight, Send } from 'lucide-react'
import { connectionStore, type PushStatus } from '@fluux/sdk'
import { disableNativePush, requestNativePushRegistration, type PushRegistrar } from '@/hooks/useNativePush'
import { Toggle } from '@/components/ui/Toggle'

export type IosPermission = 'checking' | 'granted' | 'denied' | 'default' | 'unavailable'

interface IosNotificationsCardProps {
  permission: IosPermission
  onRequestPermission: () => void
  push: PushRegistrar
  pushStatus: PushStatus
  /** The user's push preference, kept across sessions. */
  pushEnabled: boolean
  isConnected: boolean
  /** Domain of the account's server, which sends the pushes. */
  server: string
}

/** Opens Fluux's page in the iOS Settings app, where its notifications are allowed. */
async function openIosSettings(): Promise<void> {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl('app-settings:')
  } catch (error) {
    console.error('[Settings] Failed to open iOS Settings:', error)
  }
}

const PERMISSION_LABELS: Record<IosPermission, { title: string; description?: string }> = {
  checking: { title: 'settings.notificationChecking' },
  granted: { title: 'settings.iosPermission.granted', description: 'settings.iosPermission.grantedDescription' },
  denied: { title: 'settings.iosPermission.denied', description: 'settings.iosPermission.deniedDescription' },
  default: { title: 'settings.iosPermission.notDetermined', description: 'settings.iosPermission.notDeterminedDescription' },
  unavailable: { title: 'settings.iosPermission.denied', description: 'settings.iosPermission.deniedDescription' },
}

/** What the closed-app row says, given the permission, the connection and the push state. */
function closedAppDescription(
  permission: IosPermission,
  isConnected: boolean,
  pushStatus: PushStatus,
  pushEnabled: boolean,
): string {
  if (permission !== 'granted') return 'settings.closedAppPush.needsPermission'
  if (!isConnected || pushStatus === 'unknown') return 'settings.closedAppPush.offline'
  if (pushStatus === 'unsupported') return 'settings.closedAppPush.unsupported'
  if (!pushEnabled) return 'settings.closedAppPush.off'
  if (pushStatus === 'failed') return 'settings.closedAppPush.failed'
  if (pushStatus === 'enabled') return 'settings.closedAppPush.enabled'
  return 'settings.closedAppPush.activating'
}

/**
 * Notifications on iOS come in two dependent steps: iOS must allow Fluux to
 * show alerts, then the user's server alerts the phone (through the push app
 * server) while the app is closed.
 */
export function IosNotificationsCard({
  permission,
  onRequestPermission,
  push,
  pushStatus,
  pushEnabled,
  isConnected,
  server,
}: IosNotificationsCardProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  const allowed = permission === 'granted'
  const pushUsable = allowed && isConnected && pushStatus !== 'unknown' && pushStatus !== 'unsupported'
  const pushOn = pushUsable && pushEnabled

  const setPush = async (on: boolean) => {
    if (on) {
      connectionStore.getState().setWebPushEnabled(true)
      requestNativePushRegistration(push)
      return
    }
    setBusy(true)
    try {
      await disableNativePush(push)
    } catch (err) {
      console.error('[NativePush] Disable failed:', err)
    } finally {
      setBusy(false)
    }
  }

  const permissionLabels = PERMISSION_LABELS[permission]
  const closedAppText = closedAppDescription(permission, isConnected, pushStatus, pushEnabled)

  return (
    <div className="rounded-lg border-2 border-fluux-border bg-fluux-bg divide-y-2 divide-fluux-border">
      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3 min-w-0">
          {allowed
            ? <Bell className="size-5 shrink-0 text-fluux-green" />
            : <BellOff className={`size-5 shrink-0 ${permission === 'default' || permission === 'checking' ? 'text-fluux-muted' : 'text-fluux-red'}`} />}
          <div className="min-w-0">
            <p className="text-sm font-medium text-fluux-text">{t(permissionLabels.title)}</p>
            {permissionLabels.description && (
              <p className="text-xs text-fluux-muted">{t(permissionLabels.description)}</p>
            )}
          </div>
        </div>
        {permission === 'default' ? (
          <button
            type="button"
            onClick={onRequestPermission}
            className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                       bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
          >
            {t('settings.requestPermission')}
          </button>
        ) : permission !== 'checking' && (
          <button
            type="button"
            onClick={() => void openIosSettings()}
            className="shrink-0 flex items-center gap-0.5 text-sm text-fluux-brand hover:text-fluux-text transition-colors"
          >
            {t('settings.iosPermission.openSettings')}
            <ChevronRight className="size-4" />
          </button>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-3 min-w-0">
          <Send className={`size-5 shrink-0 ${
            !pushOn ? 'text-fluux-muted'
              : pushStatus === 'enabled' ? 'text-fluux-green'
              : pushStatus === 'failed' ? 'text-fluux-red'
              : 'text-fluux-yellow'
          }`} />
          <div className="min-w-0">
            <label htmlFor="closed-app-push" className="text-sm font-medium text-fluux-text">
              {t('settings.closedAppPush.title')}
            </label>
            <p className="text-xs text-fluux-muted">{t(closedAppText, { server })}</p>
            {pushOn && pushStatus === 'failed' && (
              <button
                type="button"
                onClick={() => requestNativePushRegistration(push)}
                className="mt-1 text-xs text-fluux-brand hover:text-fluux-text transition-colors"
              >
                {t('settings.closedAppPush.retry')}
              </button>
            )}
          </div>
        </div>
        <Toggle
          id="closed-app-push"
          checked={pushOn}
          disabled={!pushUsable}
          loading={busy}
          onChange={(on) => void setPush(on)}
          aria-label={t('settings.closedAppPush.title')}
        />
      </div>
    </div>
  )
}
