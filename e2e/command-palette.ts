import { expect, test } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'

for (const width of [1280, 390]) {
  test(`Cmd-K finds the open conversation by contact name at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
    await bootDemo(page, '/demo.html?tutorial=false')
    await page.evaluate(() => {
      const demo = window as unknown as { __demoClient: DemoClient }
      const client = demo.__demoClient
      client.stopAnimation()
      client.emitSDK('contacts:loaded', { contacts: [
        { jid: 'person42@example.test', name: 'Babette', presence: 'online', subscription: 'both' },
        { jid: 'person43@example.test', name: 'Babette Dupont', presence: 'offline', subscription: 'both' },
      ] })
      for (const [id, name, body] of [
        ['person42@example.test', 'Babette', 'Hello'],
        ['other@example.test', 'Other Person', 'Ask bab about lunch'],
      ]) {
        client.emitSDK('chat:conversation', { conversation: { id, name, type: 'chat', unreadCount: 0 } })
        client.emitSDK('chat:message', { message: {
          id: `fixture-${id}`, stanzaId: undefined, originId: undefined, conversationId: id, from: id, body,
          timestamp: new Date(), type: 'chat', isOutgoing: false,
        }, isLiveArrival: false })
      }
    })
    await page.locator('[data-nav="messages"]').click()
    await page.getByRole('complementary').getByText('Babette', { exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Babette', exact: true })).toBeVisible()
    // Keep row reflow from turning the parked pointer into a mouse selection.
    await page.mouse.move(0, 0)
    await page.keyboard.press('ControlOrMeta+k')
    const palette = page.getByRole('dialog')
    const input = palette.getByRole('textbox')
    await expect(input).toBeFocused()
    // The open thread stays out of empty-query suggestions.
    await expect(palette.getByRole('button', { name: /Babette person42/ })).toHaveCount(0)
    for (const query of ['bab', '@BAB', 'bette', '@ette', 'person42']) {
      await input.fill(query)
      const current = palette.getByRole('button', { name: /Babette person42/ })
      await expect(current).toHaveCount(1)
      await expect(current.locator('..').locator('.command-group-label')).toHaveText('Messages')
    }
    await input.fill('bab')
    const rows = palette.getByRole('button')
    await expect(palette.getByRole('button', { name: /Other Person/ })).toHaveCount(1)
    await expect(palette.getByRole('button', { name: /Search messages for "bab"/ })).toHaveCount(1)
    await expect(palette.getByRole('button', { name: /Babette Dupont/ }).locator('..').locator('.command-group-label')).toHaveText('Contacts')

    // Assert the rendered field and results occupy separate space on both widths.
    const field = await palette.locator('.command-search-field').boundingBox()
    const first = await rows.first().boundingBox()
    expect(first!.y).toBeGreaterThanOrEqual(field!.y + field!.height)
    const panel = await palette.boundingBox()
    expect(panel!.x).toBeGreaterThanOrEqual(0)
    expect(panel!.x + panel!.width).toBeLessThanOrEqual(width)
    await page.screenshot({ path: test.info().outputPath('contact-search.png') })

    await input.fill('person42')
    await expect(palette.getByRole('button', { name: /Babette person42/ })).toHaveAttribute('data-selected', 'true')
    await input.press('Enter')
    await expect(palette).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Babette', exact: true })).toBeVisible()
    await page.keyboard.press('ControlOrMeta+k')
    await input.fill('@bab')
    await palette.getByRole('button', { name: /Babette Dupont/ }).click()
    await expect(palette).toBeHidden()
    await expect(page.getByRole('heading', { name: 'Babette Dupont', exact: true })).toBeVisible()
  })
}
