/**
 * Settings > Encryption overview (FLM-294 direction C): one sentence on how a chat picks its method,
 * a row per method with its state, the limitations note, and a link to each method's screen.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { EncryptionSettings } from './EncryptionSettings'
import { resolveEncryptionSubPage } from './encryptionPages'

let mockStatus = 'online'
let mockDeviceCount: number | null = null
const navigateToSettings = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useConnection: () => ({ status: mockStatus, jid: 'me@example.com/laptop' }),
}))
vi.mock('@/hooks/useRouteSync', () => ({ useRouteSync: () => ({ navigateToSettings }) }))
vi.mock('./useOwnOmemoDeviceCount', () => ({ useOwnOmemoDeviceCount: () => mockDeviceCount }))
vi.mock('./OpenPgpSettings', () => ({ OpenPgpSettings: () => <div>openpgp-screen</div> }))
vi.mock('./OmemoSettings', () => ({ OmemoSettings: () => <div>omemo-screen</div> }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}|${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join('|')}` : key,
    i18n: { language: 'en' },
  }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  mockStatus = 'online'
  mockDeviceCount = null
  useEncryptionSettingsStore.setState({ openpgpEnabled: false, registrationError: null })
})

describe('EncryptionSettings overview', () => {
  it('explains how a chat picks its method and holds the limitations note', () => {
    render(<EncryptionSettings />)
    expect(screen.getByText('settings.encryption.overview.intro')).toBeTruthy()
    expect(screen.getByText('settings.encryption.limitationBackend')).toBeTruthy()
  })

  it('keeps the limitations note dismissed once closed', () => {
    const { unmount } = render(<EncryptionSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'common.close' }))
    expect(screen.queryByText('settings.encryption.limitationBackend')).toBeNull()
    unmount()
    render(<EncryptionSettings />)
    expect(screen.queryByText('settings.encryption.limitationBackend')).toBeNull()
  })

  it.each([
    ['off', { openpgpEnabled: false }, 'online', 'stateOff'],
    ['on', { openpgpEnabled: true }, 'online', 'stateOn'],
    ['waiting for a connection', { openpgpEnabled: true }, 'disconnected', 'stateWaiting'],
    ['needing attention', { openpgpEnabled: true, registrationError: { code: 'x' } }, 'online', 'stateNeedsAttention'],
  ])('reads OpenPGP %s', (_name, store, status, key) => {
    useEncryptionSettingsStore.setState(store as never)
    mockStatus = status
    render(<EncryptionSettings />)
    expect(screen.getByText(`settings.encryption.overview.${key}`)).toBeTruthy()
  })

  it('reads OMEMO as not used yet, with the device count once known', () => {
    const { unmount } = render(<EncryptionSettings />)
    expect(screen.getByText('settings.encryption.overview.omemoNotUsed')).toBeTruthy()
    unmount()
    mockDeviceCount = 3
    render(<EncryptionSettings />)
    expect(screen.getByText('settings.encryption.overview.omemoNotUsedDevices|devices=3')).toBeTruthy()
  })

  it('opens each method screen from its row', () => {
    render(<EncryptionSettings />)
    fireEvent.click(screen.getByRole('button', { name: /settings.encryption.openpgpName/ }))
    expect(navigateToSettings).toHaveBeenLastCalledWith('encryption', { subPage: 'openpgp' })
    fireEvent.click(screen.getByRole('button', { name: /settings.encryption.omemoName/ }))
    expect(navigateToSettings).toHaveBeenLastCalledWith('encryption', { subPage: 'omemo' })
  })
})

describe('EncryptionSettings sub-pages', () => {
  it('shows the screen of the requested method', () => {
    const { unmount } = render(<EncryptionSettings subPage="openpgp" />)
    expect(screen.getByText('openpgp-screen')).toBeTruthy()
    unmount()
    render(<EncryptionSettings subPage="omemo" />)
    expect(screen.getByText('omemo-screen')).toBeTruthy()
  })

  it('falls back to the overview for an unknown sub-page', () => {
    expect(resolveEncryptionSubPage('nope')).toBeNull()
    expect(resolveEncryptionSubPage(null)).toBeNull()
    expect(resolveEncryptionSubPage('omemo')).toBe('omemo')
  })
})
