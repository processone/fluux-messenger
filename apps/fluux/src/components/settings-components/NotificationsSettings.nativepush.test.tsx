/**
 * NotificationsSettings: the APNs push row on iOS, one rendering per push
 * status so no state falls through to a neutral label.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

let mockConnection: { pushStatus: string; webPushEnabled: boolean; isConnected: boolean }
const mockClient = { push: {} }
const mockDisableNativePush = vi.fn().mockResolvedValue(undefined)
const mockRequestNativePushRegistration = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ webPushStatus: 'unavailable', ...mockConnection }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

vi.mock('@/hooks/useNativePush', () => ({
  disableNativePush: (...args: unknown[]) => mockDisableNativePush(...args),
  requestNativePushRegistration: (...args: unknown[]) => mockRequestNativePushRegistration(...args),
}))

vi.mock('@/hooks/useWebPush', () => ({
  isWebPushSupported: false,
  requestWebPushRegistration: vi.fn(),
}))

vi.mock('@/hooks/useNotificationPermission', () => ({
  refreshNotificationPermission: vi.fn().mockResolvedValue(true),
  requestNotificationPermission: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/utils/tauriPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauriPlatform')>()
  return { ...actual, isMacOSDesktop: () => Promise.resolve(false) }
})

import { setPlatformForTesting } from '@/platform'
import { connectionStore } from '@fluux/sdk'
import { NotificationsSettings } from './NotificationsSettings'

describe('NotificationsSettings: native push row', () => {
  let restorePlatform: () => void

  beforeEach(() => {
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    mockConnection = { pushStatus: 'enabled', webPushEnabled: true, isConnected: true }
    mockDisableNativePush.mockClear()
    mockRequestNativePushRegistration.mockClear()
  })

  afterEach(() => restorePlatform())

  it('shows an active registration with a way to turn it off', async () => {
    render(<NotificationsSettings />)

    expect(screen.getByText('settings.pushStatus')).toBeInTheDocument()
    expect(screen.getByText('settings.webPush_registered')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /settings.webPushDisable/ }))

    await waitFor(() => expect(mockDisableNativePush).toHaveBeenCalledWith(mockClient.push))
    expect(connectionStore.getState().webPushEnabled).toBe(false)
  })

  it('offers a retry after a failed registration', () => {
    mockConnection.pushStatus = 'failed'

    render(<NotificationsSettings />)

    expect(screen.getByText('settings.push_failed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /settings.webPushEnable/ }))
    expect(mockRequestNativePushRegistration).toHaveBeenCalledWith(mockClient.push)
  })

  it('offers to enable push the account supports', () => {
    mockConnection.pushStatus = 'available'

    render(<NotificationsSettings />)

    expect(screen.getByText('settings.webPush_available')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /settings.webPushEnable/ })).toBeInTheDocument()
  })

  it('reads as turned off, with a way back, while the preference is off', () => {
    mockConnection.webPushEnabled = false

    render(<NotificationsSettings />)

    expect(screen.getByText('settings.webPush_disabled')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /settings.webPushReEnable/ }))
    expect(mockRequestNativePushRegistration).toHaveBeenCalledWith(mockClient.push)
    expect(connectionStore.getState().webPushEnabled).toBe(true)
  })

  it('reports an account without push support, with nothing to press', () => {
    mockConnection.pushStatus = 'unsupported'

    render(<NotificationsSettings />)

    expect(screen.getByText('settings.webPush_unavailable')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings.webPush/ })).not.toBeInTheDocument()
  })

  it('stays hidden until the account support is known', () => {
    mockConnection.pushStatus = 'unknown'

    render(<NotificationsSettings />)

    expect(screen.queryByText('settings.pushStatus')).not.toBeInTheDocument()
  })

  it('is not offered outside iOS', () => {
    restorePlatform()
    restorePlatform = setPlatformForTesting({ shell: 'desktop', os: 'macos' })

    render(<NotificationsSettings />)

    expect(screen.queryByText('settings.pushStatus')).not.toBeInTheDocument()
  })
})
