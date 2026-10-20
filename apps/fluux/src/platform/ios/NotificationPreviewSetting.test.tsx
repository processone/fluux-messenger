import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NotificationPreviewSetting } from './NotificationPreviewSetting'
import { useIOSPreviewSettingsStore } from './previewSettings'
const lab = vi.hoisted(() => {
  class PreviewProvisioningError extends Error { constructor(readonly problem: string) { super(problem) } }
  return { failure: null as Error | null, PreviewProvisioningError }
})
vi.mock('./notificationPreviews', () => ({
  PreviewProvisioningError: lab.PreviewProvisioningError,
  setIOSNotificationPreviews: async (next: boolean) => {
    if (lab.failure) throw lab.failure
    useIOSPreviewSettingsStore.getState().setEnabled(next)
  },
}))
afterEach(() => { cleanup(); lab.failure = null; localStorage.clear(); useIOSPreviewSettingsStore.getState().setAccount(null) })
it('shows a default-off account toggle with iOS lock-screen explanation', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByText('settings.oxNotificationPreviewDescription')).toBeVisible()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
})
it.each([
  ['credential', 'settings.oxNotificationPreviewNeedsPassword'],
  ['key', 'settings.oxNotificationPreviewKeyUnavailable'],
  ['server', 'settings.oxNotificationPreviewServerUnreachable'],
  ['unavailable', 'settings.oxNotificationPreviewFailed'],
])('explains a %s provisioning failure and leaves the preference disabled', async (problem, text) => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid'); lab.failure = new lab.PreviewProvisioningError(problem)
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('status')).toHaveTextContent(text)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})
it('reports an unexpected failure generically', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid'); lab.failure = new Error('synthetic failure')
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
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  useIOSPreviewSettingsStore.getState().setMissingCredential(true)
  render(<NotificationPreviewSetting />)
  expect(screen.queryByRole('status')).toBeNull()
})
