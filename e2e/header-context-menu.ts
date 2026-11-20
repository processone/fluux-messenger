import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

// A right-click on the contact in a one-to-one chat header opens Fluux's contact menu at the pointer,
// with the same entries as the ⋯ menu. The browser integration test proves it in both engines; the
// native menu itself is covered by the check in the Mac app.
const PEER = 'emma@fluux.chat'
const SHOTS = process.env.FLUUX_CONTEXT_MENU_SHOTS
const shot = async (page: Page, name: string, engine: string) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `header-${engine}-${name}.png`), clip: { x: 0, y: 0, width: 900, height: 480 } })
}

async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await activateChat(page, PEER)
}
const header = (page: Page) => page.locator('header').filter({ has: page.getByRole('heading', { level: 2 }) }).first()
const menu = (page: Page) => page.getByRole('menu', { name: 'More actions' })
const labels = (page: Page) => menu(page).getByRole('button').evaluateAll(els => els.map(e => e.textContent?.trim()))

test.describe('chat header right-click menu', () => {
  test('opens at the pointer on the name, avatar and status; Escape and an outside click close it', async ({ page, browserName }) => {
    await setup(page)
    const name = header(page).getByRole('heading', { level: 2 })
    const box = (await name.boundingBox())!
    const at = { x: box.x + 10, y: box.y + box.height / 2 }
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    const m = (await menu(page).boundingBox())!
    expect(Math.abs(m.x - at.x)).toBeLessThan(260)
    expect(Math.abs(m.y - at.y)).toBeLessThan(260)
    const rows = await labels(page)
    expect(rows.slice(0, 3)).toEqual(['View profile', 'Copy address', 'Search in conversation'])
    expect(rows).toContain('Block user')
    expect(rows).toContain('Remove from my contacts')
    // Right-click selects the word under the pointer in some engines; the menu opens over no selection.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect(menu(page).getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0)

    await shot(page, 'menu', browserName)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(menu(page)).toHaveCount(0)

    await header(page).locator('img, [data-testid="avatar"]').first().click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await header(page).locator('p').first().click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
  })

  test('the ⋯ menu lists the same entries', async ({ page }) => {
    await setup(page)
    await header(page).getByRole('heading', { level: 2 }).click({ button: 'right' })
    const fromContext = (await labels(page)).filter(l => l !== 'Search in conversation')
    await page.keyboard.press('Escape')
    await header(page).getByRole('button', { name: 'More actions' }).click()
    const kebab = await page.getByRole('menu').getByRole('menuitem').evaluateAll(els => els.map(e => e.textContent?.trim()))
    expect(kebab.filter(l => l !== 'Search in conversation')).toEqual(fromContext)
  })

  test('Shift + right-click and the header buttons open no Fluux menu', async ({ page }) => {
    await setup(page)
    await header(page).getByRole('heading', { level: 2 }).click({ button: 'right', modifiers: ['Shift'] })
    await expect(menu(page)).toHaveCount(0)
    await header(page).getByRole('button', { name: 'More actions' }).click({ button: 'right' })
    await expect(menu(page)).toHaveCount(0)
  })

  test('Block asks first; cancelling changes nothing', async ({ page, browserName }) => {
    await setup(page)
    await header(page).getByRole('heading', { level: 2 }).click({ button: 'right' })
    await menu(page).getByRole('button', { name: 'Block user' }).click()
    await expect(menu(page)).toHaveCount(0)
    const dialog = page.getByText(/won't be able to contact you/)
    await expect(dialog).toBeVisible()
    await shot(page, 'block-confirm', browserName)
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog).toHaveCount(0)
    await header(page).getByRole('heading', { level: 2 }).click({ button: 'right' })
    await expect(menu(page).getByRole('button', { name: 'Block user' })).toBeVisible()
    await expect(menu(page).getByRole('button', { name: 'Unblock user' })).toHaveCount(0)
  })

  test('Copy address copies the bare address', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permission is Chromium-only; unit test covers the call')
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await setup(page)
    await header(page).getByRole('heading', { level: 2 }).click({ button: 'right' })
    await menu(page).getByRole('button', { name: 'Copy address' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(PEER)
  })
})
