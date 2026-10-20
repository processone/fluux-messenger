/**
 * Intent (FLM-8, captain): with nothing set, Privacy settings show the server's own
 * archiving default; the user can override it, and clearing the override returns to
 * the server default.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ArchivingPreferences } from '@fluux/sdk'
import { PrivacySettings } from './PrivacySettings'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

let mockConnected = true
const mockClient = {
  supportsMAM: vi.fn<() => boolean>(),
  getArchivingPreferences: vi.fn<() => Promise<ArchivingPreferences>>(),
  setArchivingPreferences: vi.fn<(prefs: ArchivingPreferences) => Promise<ArchivingPreferences>>(),
}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ isConnected: mockConnected, jid: 'me@example.com/phone' }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

const serverPrefs = (policy: ArchivingPreferences['default']): ArchivingPreferences => ({
  default: policy,
  always: ['romeo@montague.lit'],
  never: ['tybalt@capulet.lit'],
})

beforeEach(() => {
  vi.clearAllMocks()
  useSettingsStore.setState({ archiveOverrides: {} })
  mockConnected = true
  mockClient.supportsMAM.mockReturnValue(true)
  mockClient.setArchivingPreferences.mockImplementation(async (prefs) => prefs)
})

describe('PrivacySettings server archiving', () => {
  it.each([
    ['always', 'settings.archiveAlways'],
    ['roster', 'settings.archiveRoster'],
    ['never', 'settings.archiveNever'],
  ] as const)('shows the server default %s as selected without changing it', async (policy, label) => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs(policy))
    render(<PrivacySettings />)

    const selected = await screen.findByRole('button', { name: label })
    expect(selected).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getAllByRole('button', { pressed: true }).filter(b => b.textContent?.startsWith('settings.archive'))).toHaveLength(1)
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
  })

  it('says it is using the server default when nothing is set', async () => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('always'))
    render(<PrivacySettings />)

    expect(await screen.findByText('settings.archiveServerDefault')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.archiveUseServerDefault' })).not.toBeInTheDocument()
  })

  it('saves an override, writes it to the server and keeps both JID lists', async () => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('always'))
    render(<PrivacySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveNever' }))

    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledWith(serverPrefs('never')))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.archiveNever' })).toHaveAttribute('aria-pressed', 'true'))
    expect(useSettingsStore.getState().archiveOverrides['me@example.com']).toEqual({ value: 'never', original: 'always' })
  })

  it('shows the override over a server value that has drifted, and clearing returns to the server default', async () => {
    useSettingsStore.setState({ archiveOverrides: { 'me@example.com': { value: 'never', original: 'always' } } })
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('never'))
    render(<PrivacySettings />)

    expect(await screen.findByRole('button', { name: 'settings.archiveNever' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'settings.archiveUseServerDefault' }))

    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledWith(serverPrefs('always')))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.archiveAlways' })).toHaveAttribute('aria-pressed', 'true'))
    expect(useSettingsStore.getState().archiveOverrides).toEqual({})
  })

  it('choosing the server default again removes the override', async () => {
    useSettingsStore.setState({ archiveOverrides: { 'me@example.com': { value: 'never', original: 'always' } } })
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('never'))
    render(<PrivacySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveAlways' }))

    await waitFor(() => expect(useSettingsStore.getState().archiveOverrides).toEqual({}))
    expect(mockClient.setArchivingPreferences).toHaveBeenCalledWith(serverPrefs('always'))
  })

  it('keeps showing the server value and reports an error when the update fails', async () => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('never'))
    mockClient.setArchivingPreferences.mockRejectedValue(new Error('not-allowed'))
    render(<PrivacySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveAlways' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('settings.archiveStatus.error')
    expect(screen.getByRole('button', { name: 'settings.archiveNever' })).toHaveAttribute('aria-pressed', 'true')
    expect(useSettingsStore.getState().archiveOverrides).toEqual({})
  })

  it('does not query the server when signed out', () => {
    mockConnected = false
    render(<PrivacySettings />)

    expect(screen.getByText('settings.archiveStatus.offline')).toBeInTheDocument()
    expect(mockClient.getArchivingPreferences).not.toHaveBeenCalled()
  })

  it('says so when the server has no message archive', () => {
    mockClient.supportsMAM.mockReturnValue(false)
    render(<PrivacySettings />)

    expect(screen.getByText('settings.archiveStatus.unsupported')).toBeInTheDocument()
    expect(mockClient.getArchivingPreferences).not.toHaveBeenCalled()
  })

  it('says so when the server setting cannot be read', async () => {
    mockClient.getArchivingPreferences.mockRejectedValue(new Error('feature-not-implemented'))
    render(<PrivacySettings />)

    expect(await screen.findByText('settings.archiveStatus.error')).toBeInTheDocument()
  })
})
