import { useState, useEffect, useRef, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, BellOff, Download, ExternalLink, Send } from 'lucide-react'
import { useConnection, useXMPPContext, connectionStore, getDomain } from '@fluux/sdk'
import { isMacOSDesktop } from '@/utils/tauriPlatform'
import {
  refreshNotificationPermission,
  requestNotificationPermission,
} from '@/hooks/useNotificationPermission'
import { isWebPushSupported, requestWebPushRegistration } from '@/hooks/useWebPush'
import { NotificationSoundSetting } from '@/platform/ios/NotificationSoundSetting'
import { NotificationPreviewSetting } from '@/platform/ios/NotificationPreviewSetting'
import { IosNotificationsCard } from './IosNotificationsCard'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { Toggle } from '@/components/ui/Toggle'
import { useSettingsStore } from '@/stores/settingsStore'
import { getTrayStatus, type TrayStatus } from '@/utils/windowBehavior'
import { platform } from '@/platform'
import { saveBadgeDiagnostics } from '@/utils/badgeDiagnosticsExport'

type NotificationStatus = 'checking' | 'granted' | 'denied' | 'default' | 'unavailable' | 'unsupported'
type NotificationSettingStatus = 'enabled' | 'disabled' | 'unknown' | 'unsupported'
type PermissionSnapshot = {
  status: NotificationStatus
  badges?: NotificationSettingStatus
  alerts?: NotificationSettingStatus
}

function settingStatus(value: unknown): NotificationSettingStatus {
  return value === 'enabled' || value === 'disabled' || value === 'unsupported' ? value : 'unknown'
}

const channelStatusKeys = {
  badges: { enabled: 'settings.badgesEnabled', disabled: 'settings.badgesDisabledMac', unsupported: 'settings.badgesUnsupported', unknown: 'settings.badgesUnknown' },
  alerts: { enabled: 'settings.alertsEnabledMac', disabled: 'settings.alertsDisabledMac', unsupported: 'settings.alertsUnsupported', unknown: 'settings.alertsUnknown' },
} as const

async function checkNotificationPermission(): Promise<PermissionSnapshot> {
  try {
    if (platform().notificationsManagedByOS) {
      if (await isMacOSDesktop()) {
        const { invoke } = await import('@tauri-apps/api/core')
        const state = await invoke<{ authorization: string; badges: unknown; alerts: unknown; alertStyle: unknown }>('notification_settings_state')
        const status = state.authorization === 'granted' || state.authorization === 'denied'
          ? state.authorization
          : state.authorization === 'notdetermined' ? 'default'
            : state.authorization === 'unsupported' ? 'unsupported' : 'unavailable'
        let alerts = settingStatus(state.alerts)
        if (alerts === 'enabled') {
          // A known None style suppresses banners/alerts. An unreadable style
          // is not the same as None, even when alert permission is enabled.
          alerts = state.alertStyle === 'none' ? 'disabled'
            : state.alertStyle === 'banner' || state.alertStyle === 'alert' ? 'enabled' : 'unknown'
        }
        return { status, badges: settingStatus(state.badges), alerts }
      }
      const { isPermissionGranted } = await import('@tauri-apps/plugin-notification')
      return { status: await isPermissionGranted() ? 'granted' : 'denied' }
    }
    if (typeof Notification === 'undefined') return { status: 'unavailable' }
    return { status: Notification.permission }
  } catch {
    return { status: 'unavailable' }
  }
}

/** Returns false when the OS pane could not be opened, so the UI can say so. */
async function openNotificationSettings(): Promise<boolean> {
  try {
    // Go through a native command rather than the shell/opener plugins: their
    // default scopes reject custom URL schemes (x-apple.systempreferences:,
    // ms-settings:), and Linux needs a control-center invocation, not a URL.
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('open_notification_settings')
    return true
  } catch (error) {
    // Linux has no single control center: the command tries each desktop's
    // settings binary and fails when none is installed. Swallowing that left
    // the button silently dead (#1072), so the caller surfaces it.
    console.error('[Settings] Failed to open notification settings:', error)
    return false
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

    await client.push.disableSubscription(service.appId, 'webpush', notificationId)
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
      await client.push.queryServices()
    } catch (err) {
      console.error('[WebPush] Re-enable: service discovery failed:', err)
    }
  }
}

export function NotificationsSettings() {
  const { t } = useTranslation()
  // "Desktop notifications" only makes sense on the desktop (Tauri) build; on
  // web/PWA — including phones — the copy must stay platform-neutral.
  const desktopBuild = platform().shell === 'desktop'
  const { client } = useXMPPContext()
  const { webPushStatus, webPushEnabled, pushStatus, isConnected, jid } = useConnection()
  const [permission, setPermission] = useState<PermissionSnapshot>({ status: 'checking' })
  const notificationStatus = permission.status
  const permissionRead = useRef(0)
  const refreshPermission = useCallback(async () => {
    const read = ++permissionRead.current
    const next = await checkNotificationPermission()
    if (read === permissionRead.current) setPermission(next)
  }, [])
  const [isMac, setIsMac] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [openSettingsFailed, setOpenSettingsFailed] = useState(false)
  const soundEnabled = useSettingsStore((state) => state.soundEnabled)
  const setSoundEnabled = useSettingsStore((state) => state.setSoundEnabled)
  const inAppBannerEnabled = useSettingsStore((state) => state.inAppBannerEnabled)
  const setInAppBannerEnabled = useSettingsStore((state) => state.setInAppBannerEnabled)
  const keepInSystemTray = useSettingsStore((state) => state.keepInSystemTray)
  const setKeepInSystemTray = useSettingsStore((state) => state.setKeepInSystemTray)
  const [trayStatus, setTrayStatus] = useState<TrayStatus | null>(null)
  const linuxDesktop = desktopBuild && platform().os === 'linux'
  const windowsDesktop = desktopBuild && platform().os === 'windows'
  const showTraySetting = linuxDesktop || windowsDesktop

  useEffect(() => {
    void isMacOSDesktop().then(setIsMac)
  }, [])

  useEffect(() => {
    if (!showTraySetting) return
    const refreshTrayStatus = () => {
      void getTrayStatus()
        .then((status) => setTrayStatus(status))
        .catch(() => setTrayStatus({ enabled: keepInSystemTray, available: false }))
    }
    refreshTrayStatus()
    window.addEventListener('focus', refreshTrayStatus)
    return () => window.removeEventListener('focus', refreshTrayStatus)
  }, [showTraySetting, keepInSystemTray])

  // Read on opening and on return, without prompting. Ignore late reads after
  // a newer refresh or unmount, including StrictMode's effect cleanup.
  useEffect(() => {
    void refreshPermission()
    const refresh = () => {
      void refreshPermission()
      void refreshNotificationPermission().catch(() => {})
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      ++permissionRead.current
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshPermission])

  // Keep the shared posting gate in sync after explicit activation.
  const handleRequestPermission = async () => {
    await requestNotificationPermission()
    await refreshPermission()
  }

  const handleOpenNotificationSettings = async () => {
    setOpenSettingsFailed(!(await openNotificationSettings()))
  }

  const handleDisableWebPush = async () => {
    setDisabling(true)
    try {
      await disableWebPush(client)
    } finally {
      setDisabling(false)
    }
  }

  const inAppSection = (
    <SettingsSection title={t('settings.inAppSection')}>
      <div className="flex items-center justify-between gap-4 p-4 fluux-card">
        <div>
          <label htmlFor="in-app-banner" className="text-sm font-medium text-fluux-text">
            {t('settings.inAppBanner')}
          </label>
          <p className="text-xs text-fluux-muted">{t('settings.inAppBannerDescription')}</p>
        </div>
        <Toggle
          id="in-app-banner"
          checked={inAppBannerEnabled}
          onChange={setInAppBannerEnabled}
          aria-label={t('settings.inAppBanner')}
        />
      </div>
    </SettingsSection>
  )

  const badgeDiagnosticsExport = (
    <button
      type="button"
      onClick={() => { void saveBadgeDiagnostics(t('console.exportBadgeDiagnosticsFailed')) }}
      className="flex items-center gap-1.5 text-sm text-fluux-brand hover:text-fluux-text transition-colors"
    >
      <Download className="size-4" />
      {t('console.exportBadgeDiagnostics')}
    </button>
  )

  if (platform().usesNativePush) {
    return (
      <section className="w-full space-y-8">
        <SettingsSection>
          <div className="space-y-3">
            <IosNotificationsCard
              permission={notificationStatus === 'unsupported' ? 'unavailable' : notificationStatus}
              onRequestPermission={() => void handleRequestPermission()}
              push={client.push}
              pushStatus={pushStatus}
              pushEnabled={webPushEnabled}
              isConnected={isConnected}
              server={jid ? getDomain(jid) : ''}
            />
            {badgeDiagnosticsExport}
          </div>
        </SettingsSection>

        <SettingsSection title={t('settings.messagePreviews')}>
          <NotificationPreviewSetting />
        </SettingsSection>

        <SettingsSection title={t('settings.soundsSection')}>
          <NotificationSoundSetting />
          <div className="flex items-center justify-between gap-4 p-4 fluux-card">
            <div>
              <label htmlFor="notification-sound" className="text-sm font-medium text-fluux-text">
                {t('settings.sound')}
              </label>
              <p className="text-xs text-fluux-muted">{t('settings.nativeSoundDescription')}</p>
            </div>
            <Toggle
              id="notification-sound"
              checked={soundEnabled}
              onChange={setSoundEnabled}
              aria-label={t('settings.sound')}
            />
          </div>
        </SettingsSection>

        {inAppSection}
      </section>
    )
  }

  const blocked = isMac && (notificationStatus === 'denied' ||
    (notificationStatus === 'granted' && [permission.badges, permission.alerts].includes('disabled')))

  return (
    <section className="w-full space-y-8">
      <SettingsSection title={t('settings.notificationPermission')}>
        <div className="space-y-3">
          <div className={`flex flex-wrap items-center justify-between gap-3 p-4 ${
            blocked ? 'rounded-lg border-2 border-fluux-yellow bg-fluux-yellow/10' : 'fluux-card'
          }`}>
            <div className="flex flex-1 basis-48 min-w-0 items-start gap-3">
              {blocked ? (
                <BellOff className="size-5 shrink-0 text-fluux-yellow" />
              ) : notificationStatus === 'granted' ? (
                <Bell className="size-5 shrink-0 text-fluux-green" />
              ) : notificationStatus === 'denied' ? (
                <BellOff className="size-5 shrink-0 text-fluux-red" />
              ) : notificationStatus === 'unavailable' || notificationStatus === 'unsupported' ? (
                <BellOff className="size-5 shrink-0 text-fluux-muted" />
              ) : (
                <Bell className="size-5 shrink-0 text-fluux-muted animate-pulse" />
              )}
              <div>
                <p className="text-sm font-medium text-fluux-text">
                  {t(desktopBuild ? 'settings.notificationStatus' : 'settings.notificationStatusWeb')}
                </p>
                <p className="text-xs text-fluux-muted">
                  {notificationStatus === 'granted' && t('settings.notificationEnabled')}
                  {notificationStatus === 'denied' && t(
                    isMac ? 'settings.notificationDeniedMac' : platform().notificationsManagedByOS
                      ? 'settings.notificationDenied'
                      : 'settings.notificationDeniedWeb',
                  )}
                  {notificationStatus === 'default' && t('settings.notificationDefault')}
                  {notificationStatus === 'unavailable' && t(isMac ? 'settings.notificationUnknownMac' : 'settings.notificationUnavailable')}
                  {notificationStatus === 'unsupported' && t('settings.notificationUnsupportedMac')}
                  {notificationStatus === 'checking' && t('settings.notificationChecking')}
                </p>
                {isMac && notificationStatus === 'granted' && (
                  <div className="mt-2 space-y-1">
                    {(['badges', 'alerts'] as const).map(channel => {
                      const state = permission[channel] ?? 'unknown'
                      return (
                        <p key={channel} role="status" className={`text-xs ${state === 'disabled' ? 'font-medium text-fluux-text' : 'text-fluux-muted'}`}>
                          {t(channelStatusKeys[channel][state])}
                        </p>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>

            {(!platform().notificationsManagedByOS || isMac) && notificationStatus === 'default' && (
              <button
                type="button"
                onClick={handleRequestPermission}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand-on-tint hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="size-4" />
                {t('settings.requestPermission')}
              </button>
            )}
          </div>

          {/* Permanent shortcut to the OS notification settings. Shown once the
                app is registered with the system notification center
                (granted/denied) so the target pane actually lists the app; hidden
                while still 'default' (never asked), where the in-card Enable button
                is the correct first action. */}
          {desktopBuild &&
            (notificationStatus === 'granted' || notificationStatus === 'denied') && (
              <div className="space-y-1.5">
                <button
                  type="button"
                  onClick={handleOpenNotificationSettings}
                  className="flex items-center gap-1.5 text-xs text-fluux-brand hover:text-fluux-text transition-colors"
                >
                  <ExternalLink className="size-3.5" />
                  {t('settings.openSystemNotificationSettings')}
                </button>
                {/* Linux desktops without a known settings binary: say so
                    rather than leaving the click with no visible effect. */}
                {openSettingsFailed && (
                  <p role="status" className="text-xs text-fluux-red">
                    {t('settings.openSystemNotificationSettingsFailed')}
                  </p>
                )}
              </div>
            )}
          {badgeDiagnosticsExport}
        </div>
      </SettingsSection>

      {isWebPushSupported && isConnected && (
        <SettingsSection title={t('settings.webPushStatus')}>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 fluux-card">
            <div className="flex flex-1 basis-48 min-w-0 items-start gap-3">
              <Send className={`size-5 shrink-0 ${
                webPushStatus === 'registered' ? 'text-fluux-green'
                  : webPushStatus === 'disabled' ? 'text-fluux-red'
                  : webPushStatus === 'available' ? 'text-fluux-yellow'
                  : 'text-fluux-muted'
              }`} />
              <div>
                <p className="text-xs text-fluux-muted">
                  {t(`settings.webPush_${webPushStatus}`)}
                </p>
              </div>
            </div>

            {webPushStatus === 'available' && webPushEnabled && (
              <button
                type="button"
                onClick={() => requestWebPushRegistration(client)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand-on-tint hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="size-4" />
                {t('settings.webPushEnable')}
              </button>
            )}

            {webPushStatus === 'registered' && (
              <button
                type="button"
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
                type="button"
                onClick={() => enableWebPush(client)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand-on-tint hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <Bell className="size-4" />
                {t('settings.webPushReEnable')}
              </button>
            )}
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.soundsSection')}>
        <div className="flex items-center justify-between gap-4 p-4 fluux-card">
          <div>
            <label htmlFor="notification-sound" className="text-sm font-medium text-fluux-text">
              {t('settings.sound')}
            </label>
            <p className="text-xs text-fluux-muted">{t('settings.soundDescription')}</p>
          </div>
          <Toggle
            id="notification-sound"
            checked={soundEnabled}
            onChange={setSoundEnabled}
            aria-label={t('settings.sound')}
          />
        </div>
      </SettingsSection>

      {inAppSection}

      {showTraySetting && (
        <SettingsSection
          title={t('settings.systemTray.title')}
          description={t(
            linuxDesktop
              ? 'settings.systemTray.descriptionLinux'
              : 'settings.systemTray.descriptionWindows',
          )}
        >
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-4 p-3 fluux-card">
              <label htmlFor="keep-in-system-tray" className="text-sm text-fluux-text">
                {t('settings.systemTray.keepInTray')}
              </label>
              <Toggle
                id="keep-in-system-tray"
                checked={keepInSystemTray}
                disabled={!trayStatus?.available}
                onChange={setKeepInSystemTray}
                aria-label={t('settings.systemTray.keepInTray')}
              />
            </div>
            {linuxDesktop && trayStatus && !trayStatus.available && (
              <p role="status" className="text-xs text-fluux-muted">
                {t('settings.systemTray.unavailableLinux')}
              </p>
            )}
          </div>
        </SettingsSection>
      )}
    </section>
  )
}
