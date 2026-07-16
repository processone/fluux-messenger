import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, ExternalLink, Send } from 'lucide-react'
import { useConnection, useXMPPContext, connectionStore } from '@fluux/sdk'
import { isTauri } from './types'
import { isMacOSDesktop } from '@/utils/tauriPlatform'
import {
  refreshNotificationPermission,
  requestNotificationPermission,
} from '@/hooks/useNotificationPermission'
import { isWebPushSupported, requestWebPushRegistration } from '@/hooks/useWebPush'
import { SettingsSection } from '@/components/ui/SettingsSection'

type NotificationStatus = 'checking' | 'granted' | 'denied' | 'default' | 'unavailable'

async function checkNotificationPermission(): Promise<NotificationStatus> {
  try {
    if (isTauri()) {
      // macOS uses the native UNUserNotificationCenter command — the same
      // source of truth as the posting gate — so Settings can't disagree with
      // whether notifications actually fire. It also distinguishes "not yet
      // asked" (notdetermined) from "denied", which the plugin can't.
      if (await isMacOSDesktop()) {
        const { invoke } = await import('@tauri-apps/api/core')
        const state = await invoke<string>('notification_permission_state')
        return state === 'granted' ? 'granted' : state === 'denied' ? 'denied' : 'default'
      }
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

async function openNotificationSettings(): Promise<void> {
  try {
    // Go through a native command rather than the shell/opener plugins: their
    // default scopes reject custom URL schemes (x-apple.systempreferences:,
    // ms-settings:), and Linux needs a control-center invocation, not a URL.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_notification_settings')
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
  // "Desktop notifications" only makes sense on the desktop (Tauri) build; on
  // web/PWA — including phones — the copy must stay platform-neutral.
  const desktopBuild = isTauri()
  const { client } = useXMPPContext()
  const { webPushStatus, webPushEnabled, isConnected } = useConnection()
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('checking')
  const [isMac, setIsMac] = useState(false)
  const [disabling, setDisabling] = useState(false)

  useEffect(() => {
    void isMacOSDesktop().then(setIsMac)
  }, [])

  useEffect(() => {
    void checkNotificationPermission()
      .then(setNotificationStatus)
      .catch(() => setNotificationStatus('unavailable'))
  }, [])

  // Re-check when the window regains focus so the status (and the runtime gate)
  // updates after the user flips the permission in System Settings and returns.
  useEffect(() => {
    const refresh = () => {
      void checkNotificationPermission()
        .then(setNotificationStatus)
        .catch(() => setNotificationStatus('unavailable'))
      void refreshNotificationPermission()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  // Request OS notification permission (the web prompt or the native dialog —
  // requestNotificationPermission branches per platform) and refresh the
  // displayed status. Crucially this goes through the SHARED module so the
  // runtime posting gate (getNotificationPermissionGranted) updates immediately;
  // a web-only local prompt left it stale until the next window focus.
  const handleRequestPermission = async () => {
    await requestNotificationPermission()
    setNotificationStatus(await checkNotificationPermission())
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
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.notifications')}>
      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-lg border-2 border-fluux-border bg-fluux-bg">
          <div className="flex items-center gap-3">
            {notificationStatus === 'granted' ? (
              <Bell className="size-5 text-fluux-green" />
            ) : notificationStatus === 'denied' ? (
              <BellOff className="size-5 text-fluux-red" />
            ) : notificationStatus === 'unavailable' ? (
              <BellOff className="size-5 text-fluux-muted" />
            ) : (
              <Bell className="size-5 text-fluux-muted animate-pulse" />
            )}
            <div>
              <p className="text-sm font-medium text-fluux-text">
                {t(desktopBuild ? 'settings.notificationStatus' : 'settings.notificationStatusWeb')}
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

          {/* Web: request permission in-page */}
          {!isTauri() && notificationStatus === 'default' && (
            <button
              onClick={handleRequestPermission}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                         bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
            >
              <Bell className="size-4" />
              {t('settings.requestPermission')}
            </button>
          )}

          {/* macOS: trigger the native OS prompt when permission was never asked */}
          {isMac && notificationStatus === 'default' && (
            <button
              onClick={handleRequestPermission}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                         bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
            >
              <Bell className="size-4" />
              {t('settings.requestPermission')}
            </button>
          )}

        </div>

        <div className="space-y-1.5">
          <p className="text-xs text-fluux-muted">
            {t(desktopBuild ? 'settings.notificationDescription' : 'settings.notificationDescriptionWeb')}
          </p>

          {/* Permanent shortcut to the OS notification settings. Shown once the
              app is registered with the system notification center
              (granted/denied) so the target pane actually lists the app; hidden
              while still 'default' (never asked), where the in-card Enable button
              is the correct first action. */}
          {isTauri() &&
            (notificationStatus === 'granted' || notificationStatus === 'denied') && (
              <button
                onClick={openNotificationSettings}
                className="flex items-center gap-1.5 text-xs text-fluux-brand hover:text-fluux-text transition-colors"
              >
                <ExternalLink className="size-3.5" />
                {t('settings.openSystemNotificationSettings')}
              </button>
            )}
        </div>

        {/* Web Push registration (browser only, when connected) */}
        {isWebPushSupported && isConnected && (
          <div className="flex items-center justify-between p-4 rounded-lg border-2 border-fluux-border bg-fluux-bg">
            <div className="flex items-center gap-3">
              <Send className={`size-5 ${
                webPushStatus === 'registered' ? 'text-fluux-green'
                  : webPushStatus === 'disabled' ? 'text-fluux-red'
                  : webPushStatus === 'available' ? 'text-fluux-yellow'
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
                <Bell className="size-4" />
                {t('settings.webPushEnable')}
              </button>
            )}

            {webPushStatus === 'registered' && (
              <button
                onClick={handleDisableWebPush}
                disabled={disabling}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-red hover:text-fluux-red/80
                           bg-fluux-red/10 hover:bg-fluux-red/20 rounded-md transition-colors disabled:opacity-50"
              >
                <BellOff className="size-4" />
                {t('settings.webPushDisable')}
              </button>
            )}

            {(webPushStatus === 'disabled' || !webPushEnabled) && webPushStatus !== 'registered' && webPushStatus !== 'available' && (
              <button
                onClick={() => enableWebPush(client)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="size-4" />
                {t('settings.webPushReEnable')}
              </button>
            )}
          </div>
        )}
      </div>
      </SettingsSection>
    </section>
  )
}
