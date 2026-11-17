import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { bootDemo } from './harness/demoBoot'

async function capture(page: Page, name: string) {
  if (process.env.FLUUX_NOTIFICATION_PROOF) {
    await page.screenshot({ path: join(process.env.FLUUX_NOTIFICATION_PROOF, name + '.png') })
  }
}
async function macSettings(page: Page) {
  await page.evaluate(async () => {
    const w = window as any
    w.__demoClient.stopAnimation()
    await w.__i18n.changeLanguage('en')
    w.__notificationSettingsFixture = w.__installNotificationSettingsFixture()
    location.hash = '/settings/notifications'
  })
  await expect(page.getByText('Desktop Notifications', { exact: true })).toBeVisible()
}

// Intent: the captain moved this sanitized export to macOS Notifications settings.
// It must remain independent of ordinary XMPP entries and keep private data out.
test('exports badge decisions from Notifications, not the empty XMPP console', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en')
    localStorage.setItem('fluux-advanced-mode', 'true')
  })
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.stopAnimation()
    const peer = 'diagnostic-sender@example.test'
    client.emitSDK('chat:conversation', { conversation: { id: peer, name: 'Diagnostic fixture', type: 'chat', unreadCount: 0 } })
    client.emitSDK('chat:message', { message: {
      id: 'diagnostic-private-message', stanzaId: undefined, originId: undefined, conversationId: peer, from: peer,
      body: 'Private diagnostic fixture content', timestamp: new Date(), type: 'chat', isOutgoing: false,
    }, isLiveArrival: true })
  })
  await page.keyboard.press('F12')
  await expect(page.getByRole('heading', { name: 'XMPP Console' })).toBeVisible()
  await page.getByRole('button', { name: 'Clear entries', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export log', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Export badge diagnostics', exact: true })).toHaveCount(0)
  await capture(page, 'after-export-console')
  await page.getByRole('button', { name: 'Close console', exact: true }).click()
  await macSettings(page)
  const action = page.getByRole('button', { name: 'Export badge diagnostics', exact: true })
  await expect(action).toBeEnabled()
  await capture(page, 'after-export-settings')
  expect(await page.evaluate(() => (window as any).__notificationSettingsFixture.writes)).toEqual([])
  await action.click()
  await expect.poll(() => page.evaluate(() => (window as any).__notificationSettingsFixture.writes.length)).toBe(1)
  const content = await page.evaluate(() => (window as any).__notificationSettingsFixture.writes[0] as string)
  const options = await page.evaluate(() => (window as any).__notificationSettingsFixture.saveOptions)
  expect(options).toEqual([{ options: { defaultPath: 'fluux-badge-diagnostics.json' } }])
  const diagnostics = JSON.parse(content)
  expect(diagnostics.format).toBe('fluux-badge-diagnostics')
  expect(diagnostics.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'arrival', status: 'accepted', unreadAfter: 1 }),
    expect.objectContaining({ phase: 'badge-request', count: expect.any(Number) }),
  ]))
  for (const privateValue of ['diagnostic-sender@example.test', 'diagnostic-private-message', 'Private diagnostic fixture content', '<message']) {
    expect(content).not.toContain(privateValue)
  }
  if (process.env.FLUUX_NOTIFICATION_PROOF) {
    await writeFile(join(process.env.FLUUX_NOTIFICATION_PROOF, 'exported-badge-diagnostics.json'), content)
  }
  // Reopen the ordinary app, not demo.tsx (which deliberately resets fixtures).
  const earlier = diagnostics.events.find((event: { phase: string; status: string }) => event.phase === 'arrival' && event.status === 'accepted')
  await page.goto('/')
  await expect(page.locator('#root')).not.toBeEmpty()
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('fluux:badge-diagnostics:v1') ?? '[]'))
  expect(persisted).toContainEqual(earlier)
})

test('exports without advanced mode or permission, preserving native cancel and error behavior', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('fluux-advanced-mode', 'false'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await macSettings(page)
  await page.evaluate(() => {
    ;(window as any).__notificationSettingsFixture.failRead = true
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByText('Could not read macOS notification permission. Return to this page to check again.')).toBeVisible()
  const action = page.getByRole('button', { name: 'Export badge diagnostics', exact: true })
  await expect(action).toBeEnabled()
  await page.evaluate(() => { (window as any).__notificationSettingsFixture.savePath = null })
  await action.click()
  await expect.poll(() => page.evaluate(() => (window as any).__notificationSettingsFixture.saveOptions.length)).toBe(1)
  expect(await page.evaluate(() => (window as any).__notificationSettingsFixture.writes)).toEqual([])
  await page.evaluate(() => {
    const f = (window as any).__notificationSettingsFixture
    f.savePath = '/disposable/fluux-badge-diagnostics.json'
    f.failWrite = true
  })
  await action.click()
  await expect(page.getByText('Could not save badge diagnostics', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => (window as any).__notificationSettingsFixture.writes)).toEqual([])
  await capture(page, 'after-export-error')
})
