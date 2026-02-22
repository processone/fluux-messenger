import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, ExternalLink } from 'lucide-react'
import { isTauri } from './types'

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

export function NotificationsSettings() {
  const { t } = useTranslation()
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('checking')

  useEffect(() => {
    void checkNotificationPermission()
      .then(setNotificationStatus)
      .catch(() => setNotificationStatus('unavailable'))
  }, [])

  const handleRequestPermission = useCallback(async () => {
    const status = await requestWebNotificationPermission()
    setNotificationStatus(status)
  }, [])

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
      </div>
    </section>
  )
}
