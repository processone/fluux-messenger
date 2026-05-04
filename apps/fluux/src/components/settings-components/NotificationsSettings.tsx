import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, ExternalLink, Send } from 'lucide-react'
import { useConnection, useXMPPContext, connectionStore } from '@fluux/sdk'
import { isTauri } from './types'
import { isWebPushSupported, requestWebPushRegistration } from '@/hooks/useWebPush'

type NotificationStatus = 'checking' | 'granted' | 'denied' | 'default' | 'unavailable'

async function checkNotificationPermission(): Promise<NotificationStatus> {
  try {
    if (isTauri()) {
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
      const granted = await isPermissionGranted()
      return granted ? 'granted' : 'denied'
    } else {
      if (typeof Notification === 'undefined') return 'unavailable'
      return Notification.permission as NotificationStatus
    }
  } catch {
    return 'unavailable'
  }
}

async function requestWebNotificationPermission(): Promise<NotificationStatus> {
  try {
    const permission = await Notification.requestPermission()
    return permission as NotificationStatus
  } catch {
    return 'denied'
  }
}

async function openNotificationSettings(): Promise<void> {
  try {
    const { open } = await import('@tauri-apps/plugin-shell')
    const { platform } = await import('@tauri-apps/plugin-os')
    const os = await platform()

    if (os === 'macos') {
      await open('x-apple.systempreferences:com.apple.Notifications-Settings.extension')
    } else if (os === 'windows') {
      await open('ms-settings:notifications')
    } else if (os === 'linux') {
      await open('gnome-control-center notifications')
    }
  } catch (error) {
    console.error('[Settings] Failed to open notification settings:', error)
  }
}

async function disableWebPush(client: any): Promise<void> {
  try {
    const { webPushServices } = connectionStore.getState()
    const service = webPushServices[0]
    if (!service) return

    const swReg = await navigator.serviceWorker.ready
    const subscription = await swReg.pushManager.getSubscription()
    if (!subscription) return

    const json = subscription.toJSON()
    const p256dh = json.keys?.p256dh
    const auth = json.keys?.auth
    if (!p256dh || !auth) return

    const notificationId = `${json.endpoint ?? subscription.endpoint}#${p256dh}#${auth}`

    await client.webPush.disableSubscription(service.appId, 'webpush', notificationId)
    connectionStore.getState().setWebPushEnabled(false)
  } catch (err) {
    console.error('[WebPush] Disable failed:', err)
  }
}

async function enableWebPush(client: any): Promise<void> {
  connectionStore.getState().setWebPushEnabled(true)
  // If services are already known, register directly; otherwise trigger discovery first
  const { webPushServices } = connectionStore.getState()
  if (webPushServices.length > 0) {
    requestWebPushRegistration(client)
  } else {
    // Trigger service discovery — the useWebPush hook will auto-register
    // once services become available and enabled is true
    try {
      await client.webPush.queryServices()
    } catch (err) {
      console.error('[WebPush] Re-enable: service discovery failed:', err)
    }
  }
}

export function NotificationsSettings() {
  const { t } = useTranslation()
  const { client } = useXMPPContext()
  const { webPushStatus, webPushEnabled, isConnected } = useConnection()
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('checking')
  const [disabling, setDisabling] = useState(false)

  useEffect(() => {
    void checkNotificationPermission()
      .then(setNotificationStatus)
      .catch(() => setNotificationStatus('unavailable'))
  }, [])

  const handleRequestPermission = async () => {
    const status = await requestWebNotificationPermission()
    setNotificationStatus(status)
  }

  const handleDisableWebPush = async () => {
    setDisabling(true)
    try {
      await disableWebPush(client)
    } finally {
      setDisabling(false)
    }
  }

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.notifications')}
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-lg border-2 border-fluux-hover bg-fluux-bg">
          <div className="flex items-center gap-3">
            {notificationStatus === 'granted' ? (
              <Bell className="w-5 h-5 text-green-500" />
            ) : notificationStatus === 'denied' ? (
              <BellOff className="w-5 h-5 text-red-500" />
            ) : notificationStatus === 'unavailable' ? (
              <BellOff className="w-5 h-5 text-fluux-muted" />
            ) : (
              <Bell className="w-5 h-5 text-fluux-muted animate-pulse" />
            )}
            <div>
              <p className="text-sm font-medium text-fluux-text">
                {t('settings.notificationStatus')}
              </p>
              <p className="text-xs text-fluux-muted">
                {notificationStatus === 'granted' && t('settings.notificationEnabled')}
                {notificationStatus === 'denied' && t('settings.notificationDenied')}
                {notificationStatus === 'default' && t('settings.notificationDefault')}
                {notificationStatus === 'unavailable' && t('settings.notificationUnavailable')}
                {notificationStatus === 'checking' && t('settings.notificationChecking')}
              </p>
            </div>
          </div>

          {/* Web: Request permission button */}
          {!isTauri && notificationStatus === 'default' && (
            <button
              onClick={handleRequestPermission}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                         bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
            >
              <Bell className="w-4 h-4" />
              {t('settings.requestPermission')}
            </button>
          )}

          {/* Tauri: Open system settings button */}
          {isTauri() && (notificationStatus === 'denied' || notificationStatus === 'default') && (
            <button
              onClick={openNotificationSettings}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                         bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
            >
              <ExternalLink className="w-4 h-4" />
              {t('settings.openSettings')}
            </button>
          )}
        </div>

        <p className="text-xs text-fluux-muted">
          {t('settings.notificationDescription')}
        </p>

        {/* Web Push registration (browser only, when connected) */}
        {isWebPushSupported && isConnected && (
          <div className="flex items-center justify-between p-4 rounded-lg border-2 border-fluux-hover bg-fluux-bg">
            <div className="flex items-center gap-3">
              <Send className={`w-5 h-5 ${
                webPushStatus === 'registered' ? 'text-green-500'
                  : webPushStatus === 'disabled' ? 'text-red-500'
                  : webPushStatus === 'available' ? 'text-yellow-500'
                  : 'text-fluux-muted'
              }`} />
              <div>
                <p className="text-sm font-medium text-fluux-text">
                  {t('settings.webPushStatus')}
                </p>
                <p className="text-xs text-fluux-muted">
                  {t(`settings.webPush_${webPushStatus}`)}
                </p>
              </div>
            </div>

            {webPushStatus === 'available' && webPushEnabled && (
              <button
                onClick={() => requestWebPushRegistration(client)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="w-4 h-4" />
                {t('settings.webPushEnable')}
              </button>
            )}

            {webPushStatus === 'registered' && (
              <button
                onClick={handleDisableWebPush}
                disabled={disabling}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-red-500 hover:text-red-400
                           bg-red-500/10 hover:bg-red-500/20 rounded-md transition-colors disabled:opacity-50"
              >
                <BellOff className="w-4 h-4" />
                {t('settings.webPushDisable')}
              </button>
            )}

            {(webPushStatus === 'disabled' || !webPushEnabled) && webPushStatus !== 'registered' && webPushStatus !== 'available' && (
              <button
                onClick={() => enableWebPush(client)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="w-4 h-4" />
                {t('settings.webPushReEnable')}
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
