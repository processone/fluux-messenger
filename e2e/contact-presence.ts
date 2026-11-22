import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'

// Finding 2: Contacts must consume batched presence without stale status or order.
// Use the demo's existing Emma contact and desktop resource, not a second roster fixture.
const PEER = 'emma@fluux.chat'
const EVIDENCE = process.env.CONTACT_PRESENCE_EVIDENCE_DIR
const row = (page: Page) => page.locator(`[data-contact-jid="${PEER}"]`)
const group = (page: Page, name: 'online' | 'offline' | 'errored') => page.locator(`[data-contact-group="${name}"]`)

async function scrollEdge(page: Page, edge: 'start' | 'end') {
  const scroller = page.locator('[data-contact-jid]').first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
  await scroller.evaluate((element, edge) => { element.scrollTop = edge === 'start' ? 0 : element.scrollHeight }, edge)
}

async function displayedCount(page: Page, section: 'Online' | 'Offline') {
  const text = await page.getByRole('heading', { name: new RegExp(`^${section} — `) }).innerText()
  const count = text.match(/—\s*(\d+)/)
  expect(count).not.toBeNull()
  return Number(count![1])
}

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
  const onlineCount = await displayedCount(page, 'Online')
  await scrollEdge(page, 'end')
  const offlineCount = await displayedCount(page, 'Offline')
  await scrollEdge(page, 'start')
  await expect(group(page, 'online').locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await photograph(page, 'contacts-initial')

  await page.evaluate(peer => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.emitSDK('contacts:presence', { fullJid: `${peer}/desktop`, show: 'away', priority: 5, statusMessage: 'Back soon' })
    client.emitSDK('contacts:presence', { fullJid: `${peer}/phone`, show: 'chat', priority: 10, statusMessage: 'On mobile' })
    client.emitSDK('contacts:presence-offline', { fullJid: `${peer}/phone` })
  }, PEER)
  await expect(row(page)).toContainText('Back soon')
  await expect(group(page, 'online').locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await photograph(page, 'contacts-away')

  await page.evaluate(peer => (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:presence-offline', { fullJid: `${peer}/desktop` }), PEER)
  await scrollEdge(page, 'end')
  await expect.poll(() => displayedCount(page, 'Offline')).toBe(offlineCount + 1)
  await expect(group(page, 'offline').locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await expect(row(page)).not.toContainText('Back soon')
  await photograph(page, 'contacts-offline')

  await page.evaluate(peer => (window as unknown as { __demoClient: DemoClient }).__demoClient.emitSDK('contacts:presence-error', { jid: peer, error: 'Remote server not found' }), PEER)
  await scrollEdge(page, 'end')
  await expect(row(page)).toContainText('Remote server not found')
  await expect(group(page, 'errored').locator(`[data-contact-jid="${PEER}"]`)).toHaveCount(1)
  await photograph(page, 'contacts-error')

  await page.evaluate(peer => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.emitSDK('contacts:presence', { fullJid: `${peer}/desktop`, show: null, priority: 5, statusMessage: 'Available again' })
    client.emitSDK('contacts:contact-updated', { jid: peer, updates: { name: 'Aaron Wilson' } })
  }, PEER)
  await scrollEdge(page, 'start')
  await expect.poll(() => displayedCount(page, 'Online')).toBe(onlineCount)
  await expect(row(page)).toContainText('Available again')
  await expect(row(page)).toContainText('Aaron Wilson')
  await expect(row(page)).not.toContainText('Remote server not found')
  await expect(group(page, 'online').locator('[data-contact-jid]').first()).toHaveAttribute('data-contact-jid', PEER)
  await photograph(page, 'contacts-recovered')
})
