import { afterEach, expect, it, vi } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import { NotificationPreviewSetting } from './NotificationPreviewSetting'
import { useIOSPreviewSettingsStore } from './previewSettings'
const lab = vi.hoisted(() => ({ fail: false }))
vi.mock('./notificationPreviews', () => ({ setIOSNotificationPreviews: async (next: boolean) => {
  if (lab.fail) throw new Error('synthetic failure')
  useIOSPreviewSettingsStore.getState().setEnabled(next)
} }))
afterEach(() => { cleanup(); lab.fail = false; localStorage.clear() })
it('shows a default-off account toggle with iOS lock-screen explanation', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid')
  render(<NotificationPreviewSetting />)
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
  expect(screen.getByText('settings.oxNotificationPreviewDescription')).toBeVisible()
  fireEvent.click(screen.getByRole('switch'))
  await waitFor(() => expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true'))
})
it('reports provisioning failure and leaves the preference disabled', async () => {
  useIOSPreviewSettingsStore.getState().setAccount('bob@nse.invalid'); lab.fail = true
  render(<NotificationPreviewSetting />)
  fireEvent.click(screen.getByRole('switch'))
  expect(await screen.findByRole('status')).toBeVisible()
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false')
})
