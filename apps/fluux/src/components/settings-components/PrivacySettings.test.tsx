/**
 * Intent (FLM-8, captain): with nothing set, the app keeps the server's own
 * archiving default, and Privacy settings show that value accurately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ArchivingPreferences } from '@fluux/sdk'
import { PrivacySettings } from './PrivacySettings'

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
    useConnection: () => ({ isConnected: mockConnected }),
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

  it('writes the chosen default to the server and keeps both JID lists', async () => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('never'))
    render(<PrivacySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveAlways' }))

    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledWith(serverPrefs('always')))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'settings.archiveAlways' })).toHaveAttribute('aria-pressed', 'true'))
  })

  it('keeps showing the server value and reports an error when the update fails', async () => {
    mockClient.getArchivingPreferences.mockResolvedValue(serverPrefs('never'))
    mockClient.setArchivingPreferences.mockRejectedValue(new Error('not-allowed'))
    render(<PrivacySettings />)

    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveAlways' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('settings.archiveStatus.error')
    expect(screen.getByRole('button', { name: 'settings.archiveNever' })).toHaveAttribute('aria-pressed', 'true')
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
