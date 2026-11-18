/**
 * OMEMO devices in Settings > Encryption (FLM-263: the account's own devices, both lists, a confirmed Remove).
 * The device-list module has its own tests against other clients' lists; here the section is checked against it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import type { OwnDeviceLists } from '@fluux/omemo-plugin/devices'
import { OmemoDevicesSection } from './OmemoDevicesSection'
import { useToastStore } from '@/stores/toastStore'

const readOwnDeviceLists = vi.fn<(...a: unknown[]) => Promise<OwnDeviceLists>>()
const removeOwnDevices = vi.fn<(...a: unknown[]) => Promise<{ removed: number[]; missing: number[] }>>()
const pep = { query: vi.fn(), publish: vi.fn() }

vi.mock('@fluux/omemo-plugin/devices', () => ({
  pepAccessFor: () => pep,
  readOwnDeviceLists: (...a: unknown[]) => readOwnDeviceLists(...a),
  removeOwnDevices: (...a: unknown[]) => removeOwnDevices(...a),
}))

let mockStatus = 'online'
const mockClient = {}
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ status: mockStatus, jid: 'me@example.com/laptop' }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}${Object.entries(opts).map(([k, v]) => `|${k}=${v}`).join('')}` : key,
    i18n: { language: 'en' },
  }),
}))

const FP = 'ab'.repeat(32)
const lists = (): OwnDeviceLists => ({
  omemo2: { ok: true, devices: [{ id: 111, label: 'Phone', fingerprint: FP }, { id: 222 }] },
  legacy: { ok: true, devices: [{ id: 333, label: 'Old laptop' }] },
})

beforeEach(() => {
  mockStatus = 'online'
  readOwnDeviceLists.mockReset().mockResolvedValue(lists())
  removeOwnDevices.mockReset().mockResolvedValue({ removed: [111], missing: [] })
  useToastStore.setState({ toasts: [] })
})

describe('OmemoDevicesSection', () => {
  it('lists the OMEMO 2 and legacy devices with name, id and fingerprint', async () => {
    render(<OmemoDevicesSection />)
    const omemo2 = await screen.findByTestId('omemo-list-omemo2')
    expect(within(omemo2).getByText('Phone')).toBeTruthy()
    expect(within(omemo2).getByText('settings.encryption.omemoDevices.unnamed')).toBeTruthy()
    expect(within(omemo2).getByText(FP.match(/.{8}/g)!.join(' '))).toBeTruthy()
    expect(within(omemo2).getByText('settings.encryption.omemoDevices.noFingerprint')).toBeTruthy()
    expect(within(screen.getByTestId('omemo-list-legacy')).getByText('Old laptop')).toBeTruthy()
    expect(readOwnDeviceLists).toHaveBeenCalledWith(pep, 'me@example.com')
  })

  it('shows a list that could not be read without hiding the other one', async () => {
    readOwnDeviceLists.mockResolvedValue({ ...lists(), legacy: { ok: false, error: new Error('boom') } })
    render(<OmemoDevicesSection />)
    const legacy = await screen.findByTestId('omemo-list-legacy')
    expect(within(legacy).getByText('settings.encryption.omemoDevices.listUnreadable')).toBeTruthy()
    expect(within(screen.getByTestId('omemo-list-omemo2')).getByText('Phone')).toBeTruthy()
  })

  it('offers a retry when nothing could be read', async () => {
    readOwnDeviceLists.mockRejectedValueOnce(new Error('offline'))
    render(<OmemoDevicesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.encryption.omemoDevices.retry' }))
    expect(await screen.findByText('Phone')).toBeTruthy()
  })

  it('reads nothing while disconnected', () => {
    mockStatus = 'offline'
    render(<OmemoDevicesSection />)
    expect(screen.getByText('settings.encryption.omemoDevices.offline')).toBeTruthy()
    expect(readOwnDeviceLists).not.toHaveBeenCalled()
  })

  it('removes nothing until the confirmation is accepted', async () => {
    render(<OmemoDevicesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.encryption.omemoDevices.removeDevice|name=Phone' }))
    expect(removeOwnDevices).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(removeOwnDevices).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('settings.encryption.omemoDevices.removeTitle')).toBeNull())
  })

  it('removes the chosen device from its own list, then reads the lists again', async () => {
    render(<OmemoDevicesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.encryption.omemoDevices.removeDevice|name=Old laptop' }))
    readOwnDeviceLists.mockResolvedValue({ omemo2: lists().omemo2, legacy: { ok: true, devices: [] } })
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.omemoDevices.removeAction' }))
    await waitFor(() => expect(removeOwnDevices).toHaveBeenCalledWith(pep, 'me@example.com', 'legacy', [333]))
    await waitFor(() => expect(screen.queryByText('Old laptop')).toBeNull())
    expect(useToastStore.getState().toasts.some((x) => x.type === 'success')).toBe(true)
  })

  it('reports a failed removal and keeps the list as the account holds it', async () => {
    removeOwnDevices.mockRejectedValue(new Error('not-allowed'))
    render(<OmemoDevicesSection />)
    fireEvent.click(await screen.findByRole('button', { name: 'settings.encryption.omemoDevices.removeDevice|name=Phone' }))
    fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.omemoDevices.removeAction' }))
    await waitFor(() => expect(useToastStore.getState().toasts.some((x) => x.type === 'error')).toBe(true))
    expect(await screen.findByText('Phone')).toBeTruthy()
  })
})
