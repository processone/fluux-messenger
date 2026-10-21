import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import type { ResourcePresence } from '@fluux/sdk'
import { setPlatformForTesting } from '@/platform'
import { AccountSection } from './AccountSection'
import { DevicesSection } from './DevicesSection'
import { DeviceListItem } from '@/components/profile-shared/DeviceListItem'
import { ProfileSettings } from '../ProfileSettings'

const state = vi.hoisted(() => ({
  isConnected: true,
  connectionMethod: 'proxy' as 'proxy' | 'websocket' | null,
  authMechanism: 'SCRAM-SHA-256-PLUS' as string | null,
  webPushStatus: 'registered',
  supportsPasswordChange: true,
  ownResources: new Map<string, ResourcePresence>(),
  jid: 'me@example.test/current',
}))
const navigateToSettings = vi.hoisted(() => vi.fn())
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@fluux/sdk', () => ({
  useConnection: () => state,
  usePresence: () => ({ presenceStatus: 'online', statusMessage: null }),
  getBareJid: (jid: string) => jid.split('/')[0],
  getLocalPart: (jid: string) => jid.split('@')[0],
  getClientType: () => 'desktop',
}))
vi.mock('@/hooks/useRouteSync', () => ({ useRouteSync: () => ({ navigateToSettings }) }))
vi.mock('./OwnProfileHero', () => ({ OwnProfileHero: () => <div>Identity</div> }))
vi.mock('./ProfileDetailsSection', () => ({ ProfileDetailsSection: () => <div>Personal details</div> }))
vi.mock('../../AvatarCropModal', () => ({ AvatarCropModal: () => null }))
vi.mock('../../ChangePasswordModal', () => ({ ChangePasswordModal: () => null }))

const device: ResourcePresence = { show: 'chat', priority: 10, client: 'Fluux Desktop' }
let restorePlatform: (() => void) | undefined
beforeEach(() => {
  restorePlatform?.()
  restorePlatform = setPlatformForTesting({ shell: 'web', os: 'linux' })
  Object.assign(state, {
    isConnected: true,
    connectionMethod: 'proxy',
    authMechanism: 'SCRAM-SHA-256-PLUS',
    webPushStatus: 'registered',
    supportsPasswordChange: true,
    ownResources: new Map([['session-123', device]]),
  })
  vi.clearAllMocks()
})

afterEach(() => restorePlatform?.())

describe('profile hierarchy', () => {
  it('puts account information before the device list', () => {
    render(<ProfileSettings />)
    const account = screen.getByRole('heading', { name: 'profile.account' })
    const devices = screen.getByRole('heading', { name: 'profile.otherConnectedDevices' })
    expect(account.compareDocumentPosition(devices) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each(['PLAIN', 'SCRAM-SHA-256', 'SCRAM-SHA-256-PLUS', 'HT-SHA-256-NONE'])('keeps the exact %s authentication and transport visible', mechanism => {
    state.authMechanism = mechanism
    render(<AccountSection onChangePassword={vi.fn()} />)
    expect(screen.getByText('profile.connection')).toBeVisible()
    expect(screen.getByText('profile.connectionMethod_proxy')).toBeVisible()
    expect(screen.getByText('profile.authentication')).toBeVisible()
    expect(screen.getByText(mechanism)).toBeVisible()
  })

  it('keeps authentication visible even when the transport is unknown', () => {
    state.connectionMethod = null
    state.supportsPasswordChange = false
    restorePlatform?.()
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    render(<AccountSection onChangePassword={vi.fn()} />)
    expect(screen.getByText('SCRAM-SHA-256-PLUS')).toBeVisible()
  })

  it('opens notification settings from the account row', () => {
    render(<AccountSection onChangePassword={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /settings.notifications/ }))
    expect(navigateToSettings).toHaveBeenCalledWith('notifications')
  })

  it('keeps password change available when supported and explains why it is unavailable offline', () => {
    const onChangePassword = vi.fn()
    const { rerender } = render(<AccountSection onChangePassword={onChangePassword} />)
    fireEvent.click(screen.getByRole('button', { name: /profile.changePassword/ }))
    expect(onChangePassword).toHaveBeenCalledOnce()
    state.isConnected = false
    rerender(<AccountSection onChangePassword={onChangePassword} />)
    expect(screen.getByRole('button', { name: /profile.changePassword/ })).toBeDisabled()
    expect(screen.getByText('profile.offlineNotice')).toBeVisible()
  })

  it('keeps device names and presence visible, with session identifiers and priorities available on demand', () => {
    render(<DevicesSection />)
    expect(within(screen.getByRole('list')).getByText('Fluux Desktop')).toBeVisible()
    expect(screen.queryByText('session-123')).not.toBeVisible()
    const details = screen.getByRole('button', { name: 'profile.deviceDetails' })
    expect(details).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(details)
    expect(screen.getByText('session-123')).toBeVisible()
    expect(screen.getByText('10')).toBeVisible()
    expect(screen.getByText('profile.sessionId')).toBeVisible()
  })

  it('retains an unidentified device resource as its visible name', () => {
    state.ownResources = new Map([['unknown-session', { show: 'away', priority: 0 }]])
    render(<DevicesSection />)
    expect(within(screen.getByRole('list')).getByText('unknown-session')).toBeVisible()
  })

  it('shows WebSocket and explains an unsupported password change', () => {
    state.connectionMethod = 'websocket'
    state.supportsPasswordChange = false
    render(<AccountSection onChangePassword={vi.fn()} />)
    expect(screen.getByText('profile.connectionMethod_websocket')).toBeVisible()
    expect(screen.getByRole('button', { name: /profile.changePassword/ })).toBeDisabled()
    expect(screen.getByText('profile.passwordChangeNotSupported')).toBeVisible()
  })

  it('shows an empty device state without an empty disclosure', () => {
    state.ownResources = new Map()
    render(<DevicesSection />)
    expect(screen.getByText('profile.noOtherDevices')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'profile.deviceDetails' })).not.toBeInTheDocument()
  })

  it('shows cached devices as offline after disconnecting', () => {
    state.isConnected = false
    render(<DevicesSection />)
    expect(within(screen.getByRole('list')).getByText('presence.offline')).toBeVisible()
  })

  it('preserves technical details by default for shared device rows used in contact profiles', () => {
    render(<ul><DeviceListItem resource="contact-session" presence={device} /></ul>)
    expect(screen.getByText(/profile.priority/)).toBeVisible()
    expect(screen.getByText(/contact-session/)).toBeVisible()
  })
})
