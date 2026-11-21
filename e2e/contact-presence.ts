import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'

// Finding 2: Contacts must consume batched presence without stale status or order.
// Use the demo's existing Emma contact and desktop resource, not a second roster fixture.
const PEER = 'emma@fluux.chat'
const EVIDENCE = process.env.CONTACT_PRESENCE_EVIDENCE_DIR
const row = (page: Page) => page.locator(`[data-contact-jid="${PEER}"]`)
const group = (page: Page, name: string) => page.getByRole('heading', { name, exact: true }).locator('..')

async function photograph(page: Page, name: string) {
  await row(page).scrollIntoViewIfNeeded()
  await expect(row(page)).toBeVisible()
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}-${test.info().project.name}.png` })
}

test('Contacts shows batched resource aggregation, offline, error recovery and name order', async ({ page }) => {
  test.setTimeout(120_000)
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false#/contacts')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await expect(row(page)).toContainText('Emma Wilson')
  const onlineCount = await page.getByRole('heading', { name: /^Online — / }).locator('..').locator('[data-contact-jid]').count()
  const offlineCount = await page.getByRole('heading', { name: /^Offline — / }).locator('..').locator('[data-contact-jid]').count()
  await expect(group(page, `Online — ${onlineCount}`).locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await photograph(page, 'contacts-initial')

  await page.evaluate(peer => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.emitSDK('contacts:presence', { fullJid: `${peer}/desktop`, show: 'away', priority: 5, statusMessage: 'Back soon' })
    client.emitSDK('contacts:presence', { fullJid: `${peer}/phone`, show: 'chat', priority: 10, statusMessage: 'On mobile' })
    client.emitSDK('contacts:presence-offline', { fullJid: `${peer}/phone` })
  }, PEER)
  await expect(row(page)).toContainText('Back soon')
  await expect(group(page, `Online — ${onlineCount}`).locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await photograph(page, 'contacts-away')

  await page.evaluate(peer => (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:presence-offline', { fullJid: `${peer}/desktop` }), PEER)
  await expect(group(page, `Offline — ${offlineCount + 1}`).locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await expect(row(page)).not.toContainText('Back soon')
  await photograph(page, 'contacts-offline')

  await page.evaluate(peer => (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:presence-error', { jid: peer, error: 'Remote server not found' }), PEER)
  await expect(row(page)).toContainText('Remote server not found')
  await expect(row(page).locator('xpath=ancestor::div[h3][1]').getByRole('heading')).toContainText('Error')
  await photograph(page, 'contacts-error')

  await page.evaluate(peer => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.emitSDK('contacts:presence', { fullJid: `${peer}/desktop`, show: null, priority: 5, statusMessage: 'Available again' })
    client.emitSDK('contacts:contact-updated', { jid: peer, updates: { name: 'Aaron Wilson' } })
  }, PEER)
  await expect(row(page)).toContainText('Available again')
  await expect(row(page)).toContainText('Aaron Wilson')
  await expect(row(page)).not.toContainText('Remote server not found')
  await expect(group(page, `Online — ${onlineCount}`).locator('[data-contact-jid]').first()).toHaveAttribute('data-contact-jid', PEER)
  await photograph(page, 'contacts-recovered')
})
