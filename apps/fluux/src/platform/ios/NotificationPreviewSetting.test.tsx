import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NotificationPreviewSetting } from './NotificationPreviewSetting'
import { useIOSPreviewSettingsStore } from './previewSettings'
const lab = vi.hoisted(() => {
  class PreviewProvisioningError extends Error { constructor(readonly problem: string) { super(problem) } }
  return { failure: null as Error | null, PreviewProvisioningError, calls: [] as [boolean, string | undefined][] }
})
vi.mock('./notificationPreviews', () => ({
  PreviewProvisioningError: lab.PreviewProvisioningError,
  setIOSNotificationPreviews: async (next: boolean, password?: string) => {
    lab.calls.push([next, password])
    if (lab.failure) throw lab.failure
    useIOSPreviewSettingsStore.getState().setEnabled(next)
  },
}))
afterEach(() => { cleanup(); lab.failure = null; lab.calls = []; localStorage.clear(); useIOSPreviewSettingsStore.getState().setAccount(null) })
/** An account whose user turned previews off, so the toggle starts off. */
function optedOut() {
  localStorage.setItem('fluux-ios-ox-previews:bob@nse.invalid', '0')
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
}
it('shows the toggle on by default with the iOS lock-screen explanation', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
  expect(screen.getByText('settings.oxNotificationPreviewDescription')).toBeVisible()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false'))
})
it('keeps the toggle off for an account that turned previews off', async () => {
  optedOut()
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
})
it.each([
  ['credential', 'settings.oxNotificationPreviewNeedsPassword'],
  ['refused', 'settings.oxNotificationPreviewPasswordRefused'],
  ['key', 'settings.oxNotificationPreviewKeyUnavailable'],
  ['server', 'settings.oxNotificationPreviewServerUnreachable'],
  ['unavailable', 'settings.oxNotificationPreviewFailed'],
])('explains a %s provisioning failure and leaves the preference disabled', async (problem, text) => {
  optedOut(); lab.failure = new lab.PreviewProvisioningError(problem)
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('status')).toHaveTextContent(text)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})
it('reports an unexpected failure generically', async () => {
  optedOut(); lab.failure = new Error('synthetic failure')
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('status')).toHaveTextContent('settings.oxNotificationPreviewFailed')
})
it('asks for a password sign-in while enabled previews have no fetch credential', () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  useIOSPreviewSettingsStore.getState().setEnabled(true)
  useIOSPreviewSettingsStore.getState().setMissingCredential(true)
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('status')).toHaveTextContent('settings.oxNotificationPreviewNeedsPassword')
})
it('shows no password hint while previews are off', () => {
  optedOut()
  useIOSPreviewSettingsStore.getState().setMissingCredential(true)
  render(<NotificationPreviewSetting />)
  expect(screen.queryByRole('status')).toBeNull()
})
it.each(['credential', 'refused'])('a %s failure asks for the password and enables previews with it', async (problem) => {
  optedOut(); lab.failure = new lab.PreviewProvisioningError(problem)
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  const field = await screen.findByLabelText('login.passwordLabel')
  expect(screen.getByRole('button', { name: 'settings.oxNotificationPreviewPasswordSubmit' })).toBeDisabled()
  lab.failure = null
  fireEvent.change(field, { target: { value: 'typed' } })
  fireEvent.click(screen.getByRole('button', { name: 'settings.oxNotificationPreviewPasswordSubmit' }))
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
  expect(lab.calls.at(-1)).toEqual([true, 'typed'])
  expect(screen.queryByLabelText('login.passwordLabel')).toBeNull()
})
it.each(['key', 'server', 'unavailable'])('a %s failure asks for no password', async (problem) => {
  optedOut(); lab.failure = new lab.PreviewProvisioningError(problem)
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByRole('status')
  expect(screen.queryByLabelText('login.passwordLabel')).toBeNull()
})
