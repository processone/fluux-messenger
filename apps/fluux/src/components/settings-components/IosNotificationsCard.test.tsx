/**
 * IosNotificationsCard: the iOS permission step, then the closed-app push step
 * that depends on it, one rendering per state so none falls through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'

const mockDisableNativePush = vi.fn().mockResolvedValue(undefined)
const mockRequestNativePushRegistration = vi.fn()
const mockOpenUrl = vi.fn().mockResolvedValue(undefined)
const mockSetWebPushEnabled = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { server?: string }) =>
      (options?.server && /\.(enabled|unsupported)$/.test(key) ? `${key}:${options.server}` : key),
  }),
}))

vi.mock('@/hooks/useNativePush', () => ({
  disableNativePush: (...args: unknown[]) => mockDisableNativePush(...args),
  requestNativePushRegistration: (...args: unknown[]) => mockRequestNativePushRegistration(...args),
}))

vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ setWebPushEnabled: mockSetWebPushEnabled }) },
}))

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: (url: string) => mockOpenUrl(url) }))

import { IosNotificationsCard } from './IosNotificationsCard'

const push = { registerDevice: vi.fn(), enable: vi.fn(), disable: vi.fn() }

function renderCard(props: Partial<ComponentProps<typeof IosNotificationsCard>> = {}) {
  const onRequestPermission = vi.fn()
  render(
    <IosNotificationsCard
      permission="granted"
      onRequestPermission={onRequestPermission}
      push={push}
      pushStatus="enabled"
      pushEnabled
      isConnected
      server="process-one.net"
      {...props}
    />,
  )
  return { onRequestPermission }
}

const pushSwitch = () => screen.getByRole('switch', { name: 'settings.closedAppPush.title' })

describe('IosNotificationsCard', () => {
  beforeEach(() => {
    mockDisableNativePush.mockClear()
    mockRequestNativePushRegistration.mockClear()
    mockOpenUrl.mockClear()
    mockSetWebPushEnabled.mockClear()
  })

  describe('iOS permission', () => {
    it('reads as allowed, with a way to the iOS Settings', async () => {
      renderCard()

      expect(screen.getByText('settings.iosPermission.granted')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /settings.iosPermission.openSettings/ }))
      await waitFor(() => expect(mockOpenUrl).toHaveBeenCalledWith('app-settings:'))
    })

    it('reads as blocked, pointing to the iOS Settings', () => {
      renderCard({ permission: 'denied' })

      expect(screen.getByText('settings.iosPermission.denied')).toBeInTheDocument()
      expect(screen.getByText('settings.iosPermission.deniedDescription')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /settings.iosPermission.openSettings/ })).toBeInTheDocument()
    })

    it('asks for the permission when iOS never asked', () => {
      const { onRequestPermission } = renderCard({ permission: 'default' })

      expect(screen.getByText('settings.iosPermission.notDetermined')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'settings.requestPermission' }))
      expect(onRequestPermission).toHaveBeenCalled()
    })
  })

  describe('closed-app push', () => {
    it('is on, naming the server that alerts the phone', () => {
      renderCard()

      expect(screen.getByText('settings.closedAppPush.enabled:process-one.net')).toBeInTheDocument()
      expect(pushSwitch()).toHaveAttribute('aria-checked', 'true')
    })

    it('turns off by disabling the registration and the preference', async () => {
      renderCard()

      fireEvent.click(pushSwitch())

      await waitFor(() => expect(mockDisableNativePush).toHaveBeenCalledWith(push))
    })

    it('reads as off and turns back on', () => {
      renderCard({ pushEnabled: false, pushStatus: 'available' })

      expect(screen.getByText('settings.closedAppPush.off')).toBeInTheDocument()
      expect(pushSwitch()).toHaveAttribute('aria-checked', 'false')
      fireEvent.click(pushSwitch())
      expect(mockRequestNativePushRegistration).toHaveBeenCalledWith(push)
      expect(mockSetWebPushEnabled).toHaveBeenCalledWith(true)
    })

    it('reads as turning on while the registration is pending', () => {
      renderCard({ pushStatus: 'available' })

      expect(screen.getByText('settings.closedAppPush.activating')).toBeInTheDocument()
    })

    it('offers a retry after a failed registration', () => {
      renderCard({ pushStatus: 'failed' })

      expect(screen.getByText('settings.closedAppPush.failed')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'settings.closedAppPush.retry' }))
      expect(mockRequestNativePushRegistration).toHaveBeenCalledWith(push)
    })

    it.each([
      ['a server without push support', { pushStatus: 'unsupported' as const }, 'settings.closedAppPush.unsupported:process-one.net'],
      ['a disconnected account', { isConnected: false }, 'settings.closedAppPush.offline'],
      ['an unchecked account', { pushStatus: 'unknown' as const }, 'settings.closedAppPush.offline'],
      ['alerts blocked by iOS', { permission: 'denied' as const }, 'settings.closedAppPush.needsPermission'],
      ['alerts not yet allowed', { permission: 'default' as const }, 'settings.closedAppPush.needsPermission'],
    ])('cannot be switched for %s', (_case, props, text) => {
      renderCard(props)

      expect(screen.getByText(text)).toBeInTheDocument()
      expect(pushSwitch()).toBeDisabled()
      expect(pushSwitch()).toHaveAttribute('aria-checked', 'false')
    })
  })
})
