/** Accepted macOS badge-warning intent: actual Settings page, controlled OS
 * responses. No account, permission change, settings launch or Dock claim.
 */
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { join } from 'node:path'

test.use({ viewport: { width: 1280, height: 900 } })

async function setup(page: Page, authorization = 'granted', badges = 'disabled') {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(async ({ authorization, badges }) => {
    const w = window as any
    w.__demoClient.stopAnimation()
    await w.__i18n.changeLanguage('en')
    w.__notificationSettingsFixture = w.__installNotificationSettingsFixture(authorization, badges)
    location.hash = '/settings/notifications'
  }, { authorization, badges })
  await expect(page.getByText('Desktop Notifications', { exact: true })).toBeVisible()
}
async function state(page: Page, authorization: string, badges: string, event = 'focus') {
  await page.evaluate(({ authorization, badges, event }) => {
    const f = (window as any).__notificationSettingsFixture
    Object.assign(f, { authorization, badges })
    if (event === 'focus') window.dispatchEvent(new Event('focus'))
    else document.dispatchEvent(new Event('visibilitychange'))
  }, { authorization, badges, event })
}
async function capture(page: Page, name: string) {
  if (process.env.FLUUX_NOTIFICATION_PROOF) {
    await page.screenshot({ path: join(process.env.FLUUX_NOTIFICATION_PROOF, name + '.png') })
  }
}
const badgeWarning = 'App icon badges disabled in macOS. Enable them in system settings.'
const denied = 'Notifications blocked in macOS. Enable them in system settings.'
const enabled = 'App icon badges enabled'
const unknown = 'Could not read macOS notification permission. Return to this page to check again.'
const link = 'Open system notification settings'

test('shows precise permission states and refreshes without automatic actions', async ({ page }) => {
  await setup(page)
  await expect(page.getByText(badgeWarning, { exact: true })).toBeVisible()
  await capture(page, 'after-badges-disabled')
  await state(page, 'denied', 'disabled')
  await expect(page.getByText(denied, { exact: true })).toBeVisible()
  await expect(page.getByText(badgeWarning, { exact: true })).toHaveCount(0)
  await capture(page, 'after-denied')
  await state(page, 'granted', 'enabled', 'visibilitychange')
  await expect(page.getByText(enabled, { exact: true })).toBeVisible()
  await expect(page.getByText(denied, { exact: true })).toHaveCount(0)
  await capture(page, 'after-enabled')
  await state(page, 'unknown', 'enabled')
  await expect(page.getByText(unknown, { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Enable', exact: true })).toHaveCount(0)
  await capture(page, 'after-unknown')
  await state(page, 'unsupported', 'unsupported')
  await expect(page.getByText('Notification permission is not supported in this environment.')).toBeVisible()
  await capture(page, 'after-unsupported')
  await state(page, 'granted', 'unsupported')
  await expect(page.getByText('App icon badges are not supported.')).toBeVisible()
  await state(page, 'granted', 'unknown')
  await expect(page.getByText('App icon badge permission is unknown.')).toBeVisible()
  await page.evaluate(() => {
    ;(window as any).__notificationSettingsFixture.failRead = true
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByText(unknown, { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => (window as any).__notificationSettingsFixture.calls as string[])
  expect(calls).not.toContain('open_notification_settings')
  expect(calls).not.toContain('request_notification_permission')
})

test('opens only on click, keeps failures visible and preserves preferences', async ({ page }) => {
  await setup(page)
  await expect(page.getByText(badgeWarning, { exact: true })).toBeVisible()
  const original = await page.evaluate(() => {
    const s = (window as any).__settingsStore.getState()
    return { sound: s.soundEnabled, banner: s.inAppBannerEnabled }
  })
  await page.getByRole('switch', { name: 'Play notification sounds', exact: true }).click()
  await page.getByRole('switch', { name: 'Show banner', exact: true }).click()
  await expect(page.getByText(badgeWarning, { exact: true })).toBeVisible()
  await page.evaluate(() => { (window as any).__notificationSettingsFixture.failOpen = true })
  await page.getByRole('button', { name: link }).click()
  const failure = page.getByText(/Could not open the system notification settings/i)
  await expect(failure).toBeVisible()
  await capture(page, 'after-opening-error')
  await page.evaluate(() => { (window as any).__notificationSettingsFixture.failOpen = false })
  await page.getByRole('button', { name: link }).click()
  await expect(failure).toHaveCount(0)
  await state(page, 'granted', 'enabled')
  await expect(page.getByText(enabled, { exact: true })).toBeVisible()
  const result = await page.evaluate(() => {
    const w = window as any
    const s = w.__settingsStore.getState()
    return { sound: s.soundEnabled, banner: s.inAppBannerEnabled, calls: w.__notificationSettingsFixture.calls as string[] }
  })
  expect(result.sound).toBe(!original.sound)
  expect(result.banner).toBe(!original.banner)
  expect(result.calls.filter(c => c === 'open_notification_settings')).toHaveLength(2)
  expect(result.calls).not.toContain('request_notification_permission')
})

test('retains explicit activation for not-requested permission and translates the warning', async ({ page }) => {
  await setup(page, 'notdetermined', 'disabled')
  const button = page.getByRole('button', { name: 'Enable', exact: true })
  await expect(button).toBeVisible()
  await expect(page.getByRole('button', { name: link })).toHaveCount(0)
  await capture(page, 'after-not-requested')
  await button.click()
  await expect(page.getByText(badgeWarning, { exact: true })).toBeVisible()
  const calls = await page.evaluate(() => (window as any).__notificationSettingsFixture.calls as string[])
  expect(calls.filter(c => c === 'request_notification_permission')).toHaveLength(1)
  await page.evaluate(async () => { await (window as any).__i18n.changeLanguage('fr') })
  await expect(page.getByText('Badges de l’icône désactivés dans macOS. Activez-les dans les réglages système.')).toBeVisible()
  await capture(page, 'after-badges-disabled-fr')
})

test('warns only for retained macOS badges and alerts without treating unknown as off', async ({ page }) => {
  await setup(page, 'granted', 'enabled')
  for (const scenario of [
    { badges: 'enabled', alerts: 'disabled', alertStyle: 'banner', alertText: 'Alerts disabled in macOS', picture: 'after-alerts-disabled' },
    { badges: 'enabled', alerts: 'enabled', alertStyle: 'none', alertText: 'Alerts disabled in macOS', picture: 'after-alert-style-none' },
    { badges: 'enabled', alerts: 'enabled', alertStyle: 'alert', alertText: 'Alerts enabled in macOS', picture: 'after-alert-style-alert' },
    { badges: 'disabled', alerts: 'enabled', alertStyle: 'none', alertText: 'Alerts disabled in macOS', picture: 'after-badges-and-alerts-disabled' },
    { badges: 'enabled', alerts: 'unknown', alertStyle: 'none', alertText: 'macOS alert settings are unknown', picture: 'after-alerts-unknown' },
    { badges: 'enabled', alerts: 'unsupported', alertStyle: 'none', alertText: 'Alerts are not supported', picture: 'after-alerts-unsupported' },
    { badges: 'enabled', alerts: 'enabled', alertStyle: 'future-style', alertText: 'macOS alert settings are unknown', picture: 'after-alert-style-unknown' },
    { badges: 'enabled', alerts: 'enabled', alertStyle: 'banner', alertText: 'Alerts enabled in macOS', picture: 'after-alerts-restored' },
  ]) {
    await page.evaluate(scenario => {
      const f = (window as any).__notificationSettingsFixture
      Object.assign(f, { badges: scenario.badges, alerts: scenario.alerts, alertStyle: scenario.alertStyle })
      window.dispatchEvent(new Event('focus'))
    }, scenario)
    await expect(page.getByText(scenario.alertText, { exact: true })).toBeVisible()
    await expect(page.getByText('Alerts disabled in macOS', { exact: true })).toHaveCount(scenario.alertText === 'Alerts disabled in macOS' ? 1 : 0)
    await expect(page.getByText(badgeWarning, { exact: true })).toHaveCount(scenario.badges === 'disabled' ? 1 : 0)
    const statuses = page.getByRole('heading', { name: 'Permission', exact: true }).locator('..').getByRole('status')
    await expect(statuses).toHaveText([
      scenario.badges === 'disabled' ? badgeWarning : enabled,
      scenario.alertText,
    ])
    await capture(page, scenario.picture)
  }
  const calls = await page.evaluate(() => (window as any).__notificationSettingsFixture.calls as string[])
  expect(calls).not.toContain('request_notification_permission')
  expect(calls).not.toContain('open_notification_settings')
})
