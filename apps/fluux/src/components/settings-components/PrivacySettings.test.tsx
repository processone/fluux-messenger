/** Intent FLM-39 (captain): show only server-confirmed policies, preserve exceptions,
 * serialize saves and isolate accounts/sessions. Legacy overrides must not write on reconnect. */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ArchivingPreferences } from '@fluux/sdk'
import { PrivacySettings } from './PrivacySettings'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let mockConnected = true
let mockJid = 'me@example.com/phone'
const mockClient = {
  supportsMAM: vi.fn<() => boolean>(),
  getArchivingPreferences: vi.fn<() => Promise<ArchivingPreferences>>(),
  setArchivingPreferences: vi.fn<(prefs: ArchivingPreferences) => Promise<ArchivingPreferences>>(),
}
vi.mock('@fluux/sdk', async (importOriginal) => ({
  ...await importOriginal<typeof import('@fluux/sdk')>(),
  useConnection: () => ({ isConnected: mockConnected, status: mockConnected ? 'online' : 'reconnecting', jid: mockJid }),
  useXMPPContext: () => ({ client: mockClient }),
}))
const prefs = (policy: ArchivingPreferences['default']): ArchivingPreferences => ({
  default: policy, always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit'],
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
const option = (name: string) => screen.getByRole('button', { name: `settings.archive${name}` })

beforeEach(() => {
  vi.resetAllMocks()
  useSettingsStore.setState({ archiveOverrides: {} })
  mockConnected = true
  mockJid = 'me@example.com/phone'
  mockClient.supportsMAM.mockReturnValue(true)
  mockClient.getArchivingPreferences.mockResolvedValue(prefs('roster'))
  mockClient.setArchivingPreferences.mockImplementation(async p => p)
})

describe('server archiving policy', () => {
  it.each([['always', 'Always'], ['roster', 'Roster'], ['never', 'Never']] as const)(
    'reads %s without writing', async (policy, label) => {
      mockClient.getArchivingPreferences.mockResolvedValue(prefs(policy))
      render(<PrivacySettings />)
      await waitFor(() => expect(option(label)).toHaveAttribute('aria-pressed', 'true'))
      expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
    })

  it('ignores a divergent local override and keeps the legacy data intact', async () => {
    const legacy = { 'me@example.com': { value: 'always', original: 'roster' } } as const
    useSettingsStore.setState({ archiveOverrides: legacy })
    mockClient.getArchivingPreferences.mockResolvedValue(prefs('never'))
    render(<PrivacySettings />)
    await waitFor(() => expect(option('Never')).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.queryByText('settings.archiveUseServerDefault')).not.toBeInTheDocument()
    expect(useSettingsStore.getState().archiveOverrides).toEqual(legacy)
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
  })

  it('refreshes both exception lists immediately before writing, and shows the returned policy', async () => {
    const fresh = { ...prefs('always'), always: ['juliet@capulet.lit'], never: ['paris@verona.lit'] }
    mockClient.getArchivingPreferences.mockResolvedValueOnce(prefs('roster')).mockResolvedValue(fresh)
    mockClient.setArchivingPreferences.mockResolvedValue({ ...fresh, default: 'always' })
    render(<PrivacySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveNever' }))
    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledWith({ ...fresh, default: 'never' }))
    await waitFor(() => expect(option('Always')).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByText('settings.archiveExceptions')).toBeInTheDocument()
    expect(useSettingsStore.getState().archiveOverrides).toEqual({})
  })

  it('makes saving visible, keeps the confirmed selection, and prevents double clicks', async () => {
    const write = deferred<ArchivingPreferences>()
    mockClient.setArchivingPreferences.mockReturnValue(write.promise)
    render(<PrivacySettings />)
    const never = await screen.findByRole('button', { name: 'settings.archiveNever' })
    fireEvent.click(never); fireEvent.click(never)
    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledTimes(1))
    expect(screen.getByText('settings.archiveStatus.saving')).toBeInTheDocument()
    expect(option('Roster')).toHaveAttribute('aria-pressed', 'true')
    expect(never).toBeDisabled()
    await act(async () => write.resolve(prefs('never')))
    expect(never).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([
    ['forbidden', 'denied'], ['not-allowed', 'denied'], ['feature-not-implemented', 'unsupported'],
    ['service-unavailable', 'unsupported'], ['RequestTimeoutError', 'timeout'], ['invalid', 'invalid'], ['network', 'error'],
  ])('keeps the confirmed value after %s and retries by reading, not resubmitting', async (condition, status) => {
    const error = Object.assign(new Error(condition), { condition, name: condition, code: condition })
    mockClient.setArchivingPreferences.mockRejectedValue(error)
    render(<PrivacySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveNever' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(`settings.archiveStatus.${status}`)
    expect(option('Roster')).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'settings.archiveRefresh' }))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
    expect(mockClient.setArchivingPreferences).toHaveBeenCalledTimes(1)
  })

  it('shows a read failure and a working retry', async () => {
    mockClient.getArchivingPreferences.mockRejectedValueOnce(new Error('network'))
    render(<PrivacySettings />)
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.archiveStatus.error')
    fireEvent.click(screen.getByRole('button', { name: 'settings.archiveRefresh' }))
    await waitFor(() => expect(option('Roster')).toHaveAttribute('aria-pressed', 'true'))
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
  })

  it.each(['account', 'disconnect'] as const)('discards a late read after %s', async transition => {
    const read = deferred<ArchivingPreferences>()
    mockClient.getArchivingPreferences.mockReturnValueOnce(read.promise)
    const view = render(<PrivacySettings />)
    expect(screen.getByText('settings.archiveStatus.loading')).toBeInTheDocument()
    if (transition === 'account') mockJid = 'juliet@capulet.lit/tablet'
    else mockConnected = false
    view.rerender(<PrivacySettings />)
    await act(async () => read.resolve(prefs('always')))
    expect(screen.queryByRole('button', { name: 'settings.archiveAlways', pressed: true })).not.toBeInTheDocument()
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
  })

  it('does not write after a session ends during the pre-save refresh', async () => {
    const read = deferred<ArchivingPreferences>()
    mockClient.getArchivingPreferences.mockResolvedValueOnce(prefs('roster')).mockReturnValueOnce(read.promise)
    const view = render(<PrivacySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveNever' }))
    mockConnected = false
    view.rerender(<PrivacySettings />)
    await act(async () => read.resolve(prefs('roster')))
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
    expect(screen.getByText('settings.archiveStatus.offline')).toBeInTheDocument()
  })

  it('discards a late write confirmation after switching accounts', async () => {
    const write = deferred<ArchivingPreferences>()
    mockClient.setArchivingPreferences.mockReturnValue(write.promise)
    const view = render(<PrivacySettings />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.archiveNever' }))
    await waitFor(() => expect(mockClient.setArchivingPreferences).toHaveBeenCalledTimes(1))
    mockJid = 'juliet@capulet.lit/tablet'
    view.rerender(<PrivacySettings />)
    await waitFor(() => expect(option('Roster')).toHaveAttribute('aria-pressed', 'true'))
    await act(async () => write.resolve(prefs('never')))
    expect(option('Roster')).toHaveAttribute('aria-pressed', 'true')
    expect(useSettingsStore.getState().archiveOverrides).toEqual({})
  })

  it('reconnects after Nothing without replaying a legacy choice over another client', async () => {
    useSettingsStore.setState({ archiveOverrides: { 'me@example.com': { value: 'always', original: 'roster' } } })
    mockClient.getArchivingPreferences.mockResolvedValue(prefs('never'))
    const view = render(<PrivacySettings />)
    await waitFor(() => expect(option('Never')).toHaveAttribute('aria-pressed', 'true'))
    mockConnected = false; view.rerender(<PrivacySettings />)
    expect(screen.getByText('settings.archiveStatus.offline')).toBeInTheDocument()
    mockConnected = true; view.rerender(<PrivacySettings />)
    await waitFor(() => expect(option('Never')).toHaveAttribute('aria-pressed', 'true'))
    expect(mockClient.setArchivingPreferences).not.toHaveBeenCalled()
  })

  it('does not query when offline or MAM is absent', () => {
    mockConnected = false
    const view = render(<PrivacySettings />)
    expect(screen.getByText('settings.archiveStatus.offline')).toBeInTheDocument()
    mockConnected = true; mockClient.supportsMAM.mockReturnValue(false)
    view.rerender(<PrivacySettings />)
    expect(screen.getByText('settings.archiveStatus.unsupported')).toBeInTheDocument()
    expect(mockClient.getArchivingPreferences).not.toHaveBeenCalled()
  })
})
