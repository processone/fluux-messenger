import { expect, test } from '@playwright/test'

// A real software keyboard needs the iOS simulator. This exercises the layout
// response to the same VisualViewport events in both browser engines.
for (const form of ['join', 'members']) {
  for (const height of [400, 230]) {
    test(`${form} form actions remain reachable with ${height}px above the keyboard`, async ({ page }) => {
      await page.addInitScript(() => {
        localStorage.setItem('i18nextLng', 'en')
        const viewport = Object.assign(new EventTarget(), { width: 390, height: 844, offsetTop: 0, offsetLeft: 0, scale: 1 })
        Object.defineProperty(window, 'visualViewport', { value: viewport, configurable: true })
      })
      await page.goto('/demo.html?tutorial=false', { waitUntil: 'domcontentloaded' })
      await page.locator('[data-nav="rooms"]').click()
      if (form === 'join') {
        await page.getByRole('button', { name: 'Options', exact: true }).click()
        await page.getByText('Join room', { exact: true }).click()
      } else {
        await page.getByText('Team Chat', { exact: true }).click()
        await page.getByRole('button', { name: 'Room actions', exact: true }).click()
        const manage = page.getByRole('button', { name: 'Manage room', exact: true })
        if (await manage.isVisible()) await manage.click()
        await page.getByText('Manage Membership', { exact: true }).click()
      }
      const panel = page.locator('[data-modal] > .fluux-glass')
      await expect(panel).toBeVisible()
      await page.evaluate((height) => {
        Object.assign(window.visualViewport!, { height, offsetTop: 30 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
      }, height)
      await expect.poll(async () => {
        const box = await panel.boundingBox()
        return box ? box.y >= 30 && box.y + box.height <= height + 30 : false
      }).toBe(true)
      if (form === 'members') {
        const add = panel.getByRole('button', { name: 'Add', exact: true })
        await add.scrollIntoViewIfNeeded()
        const addBox = await add.boundingBox()
        expect(addBox!.y).toBeGreaterThanOrEqual(30)
        expect(addBox!.y + addBox!.height).toBeLessThanOrEqual(height + 30)
      }
      const cancel = panel.getByRole('button', { name: form === 'join' ? 'Cancel' : 'Close', exact: true })
      await cancel.scrollIntoViewIfNeeded()
      const box = await cancel.boundingBox()
      expect(box!.y + box!.height).toBeLessThanOrEqual(height + 30)
      await page.screenshot({ path: `test-results/modal-keyboard-${form}-${height}-${test.info().project.name}.png` })
      await page.evaluate(() => {
        Object.assign(window.visualViewport!, { height: window.innerHeight, offsetTop: 0 })
        window.visualViewport!.dispatchEvent(new Event('resize'))
      })
      await expect(page.locator('[data-modal]')).not.toHaveAttribute('data-keyboard', 'true')
      await cancel.click()
      await expect(panel).toBeHidden()
    })
  }
}
