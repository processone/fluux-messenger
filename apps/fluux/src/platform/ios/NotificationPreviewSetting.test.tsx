import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NotificationPreviewSetting } from './NotificationPreviewSetting'
import { useIOSPreviewSettingsStore } from './previewSettings'
const lab = vi.hoisted(() => ({
  failure: null as { problem: 'credential' | 'refused' | 'key' | 'server' | 'unavailable'; detail?: string } | null,
  calls: [] as [boolean, string | undefined][],
}))
// Like the controller, the mock keeps the user's choice and records any failure in the store.
vi.mock('./notificationPreviews', () => ({
  setIOSNotificationPreviews: async (next: boolean, password?: string) => {
    lab.calls.push([next, password])
    useIOSPreviewSettingsStore.getState().setEnabled(next)
    useIOSPreviewSettingsStore.getState().setFailure(lab.failure)
    if (lab.failure) throw new Error(lab.failure.problem)
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
] as const)('explains a %s provisioning failure and keeps the preference on', async (problem, text) => {
  optedOut(); lab.failure = { problem }
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('status')).toHaveTextContent(text)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true')
})
it('shows the native detail of an unavailable failure', async () => {
  optedOut(); lab.failure = { problem: 'unavailable', detail: 'Notification preview state unavailable (-34018)' }
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByText('Notification preview state unavailable (-34018)')).toBeVisible()
})
it('explains a failure recorded while the app provisioned previews on its own', () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  useIOSPreviewSettingsStore.getState().setFailure({ problem: 'server' })
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('status')).toHaveTextContent('settings.oxNotificationPreviewServerUnreachable')
})
it('hides a recorded failure once previews are turned off', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  useIOSPreviewSettingsStore.getState().setFailure({ problem: 'server' })
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
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
it.each(['credential', 'refused'] as const)('a %s failure asks for the password and enables previews with it', async (problem) => {
  optedOut(); lab.failure = { problem }
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
it.each(['key', 'server', 'unavailable'] as const)('a %s failure asks for no password', async (problem) => {
  optedOut(); lab.failure = { problem }
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  await screen.findByRole('status')
  expect(screen.queryByLabelText('login.passwordLabel')).toBeNull()
})
