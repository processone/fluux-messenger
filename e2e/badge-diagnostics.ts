import { expect, test } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { readFile } from 'node:fs/promises'
import { bootDemo } from './harness/demoBoot'

// Intent: the approved separate sanitized export is usable during ordinary use,
// even with no XMPP entries. Journal limit details belong to its unit tests.
test('exports badge decisions separately from an empty XMPP console', async ({ page }) => {
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
  const action = page.getByRole('button', { name: 'Export badge diagnostics', exact: true })
  await expect(action).toBeEnabled()
  await action.hover()
  await expect(page.getByRole('tooltip', { name: 'Export badge diagnostics', exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('badge-diagnostics-console.png') })
  const downloaded = page.waitForEvent('download')
  await action.click()
  const file = await downloaded
  expect(file.suggestedFilename()).toBe('fluux-badge-diagnostics.json')
  const path = test.info().outputPath(file.suggestedFilename())
  await file.saveAs(path)
  const content = await readFile(path, 'utf8')
  const diagnostics = JSON.parse(content)
  expect(diagnostics.format).toBe('fluux-badge-diagnostics')
  expect(diagnostics.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ phase: 'arrival', status: 'accepted', unreadAfter: 1 }),
    expect.objectContaining({ phase: 'badge-request', count: expect.any(Number) }),
  ]))
  for (const privateValue of ['diagnostic-sender@example.test', 'diagnostic-private-message', 'Private diagnostic fixture content', '<message']) {
    expect(content).not.toContain(privateValue)
  }
  // Reopen the ordinary app, not demo.tsx (which deliberately resets its fixtures).
  // Its startup journal must retain the earlier anonymous decisions across a reload.
  const earlier = diagnostics.events.find((event: { phase: string; status: string }) => event.phase === 'arrival' && event.status === 'accepted')
  await page.goto('/')
  await expect(page.locator('#root')).not.toBeEmpty()
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('fluux:badge-diagnostics:v1') ?? '[]'))
  expect(persisted).toContainEqual(earlier)
})
