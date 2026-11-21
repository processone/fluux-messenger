import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { MAX_SUGGESTIONS } from '../apps/fluux/src/constants/ui'
import { bootDemo } from './harness/demoBoot'

// Suggestion mounts must be bounded without losing a late search
// result; Contacts must retain the entire scrollable roster. Exercise the real
// components and SDK event bindings, not a substitute renderer or timing budget.
const ROSTER_SIZE = 2000
const lastContact = `Colleague ${ROSTER_SIZE - 1}`
const lastNick = `U0_${ROSTER_SIZE - 1}`

async function bootLongRoster(page: Page) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  // No activate:1: that fixture deliberately reasserts the room route for three
  // seconds and would undo navigation made while testing the other surfaces.
  await bootDemo(page, `/demo.html?tutorial=false&stress=rooms:1,messages:5,occupants:${ROSTER_SIZE},msgStep:0`)
  await page.evaluate((count) => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    client.stopAnimation()
    client.emitSDK('contacts:loaded', { contacts: Array.from({ length: count }, (_,i) => ({
      jid: `colleague${String(i).padStart(4, '0')}@example.test`,
      name: `Colleague ${String(i).padStart(4, '0')}`,
      presence: i % 2 ? 'online' as const : 'offline' as const,
      subscription: 'both' as const,
    })) })
  }, ROSTER_SIZE)
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await bootLongRoster(page)
})

test('palette bounds each group and still opens a late contact', async ({ page }) => {
  await page.mouse.move(0, 0)
  await page.keyboard.press('ControlOrMeta+k')
  const palette = page.getByRole('dialog')
  const input = palette.getByRole('textbox')
  await input.fill('@colleague')
  const contacts = palette.locator('.command-group-label').filter({ hasText: /^Contacts$/ }).locator('..').locator('.command-row')
  await expect(contacts).toHaveCount(MAX_SUGGESTIONS)
  await input.fill(`@colleague${ROSTER_SIZE - 1}`)
  await expect(contacts).toHaveCount(1)
  await input.press('Enter')
  await expect(palette).toBeHidden()
  await expect(page.getByRole('heading', { name: lastContact, exact: true })).toBeVisible()
})

test('recipient suggestions stay bounded and selected contacts stay excluded', async ({ page }) => {
  await page.locator('[data-nav="rooms"]').click()
  await page.getByRole('button', { name: 'Create Quick Chat', exact: true }).click()
  const input = page.getByPlaceholder('Search contacts...')
  await input.focus()
  const suggestions = page.getByTestId('contact-suggestions').getByRole('button')
  await expect(suggestions).toHaveCount(MAX_SUGGESTIONS)
  await input.fill(`colleague${ROSTER_SIZE - 1}`)
  await expect(suggestions).toHaveCount(1)
  await input.press('ArrowDown')
  await input.press('Enter')
  await expect(page.getByText(lastContact, { exact: true })).toBeVisible()
  const more = page.getByPlaceholder('Add more contacts...')
  await more.fill(`colleague${ROSTER_SIZE - 1}`)
  await expect(page.getByTestId('contact-suggestions').getByText(lastContact, { exact: true })).toHaveCount(0)
})

test('mention suggestions bound keyboard navigation and retain late nicknames', async ({ page }) => {
  await page.locator('[data-nav="rooms"]').click()
  await page.getByText('Stress 0', { exact: true }).click()
  const editor = page.getByRole('combobox', { name: /Stress 0/ })
  await editor.click()
  await page.keyboard.type('@')
  const options = page.getByRole('listbox').getByRole('option')
  await expect(options).toHaveCount(MAX_SUGGESTIONS)
  await editor.press('ArrowUp')
  await expect(options.last()).toHaveAttribute('aria-selected', 'true')
  // The combobox's announced descendant must name an option that actually exists.
  await expect(editor).toHaveAttribute('aria-activedescendant', await options.last().getAttribute('id') as string)
  await editor.press('ControlOrMeta+a')
  await editor.press('Backspace')
  await page.keyboard.type(`@${lastNick}`)
  await expect(options).toHaveCount(1)
  await editor.press('Enter')
  await expect(editor.locator('[data-mention]')).toHaveText(`@${lastNick}`)
})

test('Contacts windows rows but keeps scroll, search and keyboard navigation', async ({ page }) => {
  await page.locator('[data-nav="contacts"]').click()
  const rows = page.locator('[data-contact-jid]')
  await expect(rows.first()).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
  const scroller = rows.first().locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]')
  await scroller.evaluate(element => { element.scrollTop = element.scrollHeight })
  // The last offline contact sorts after the last online contact.
  const lastOffline = `colleague${String(ROSTER_SIZE - 2).padStart(4, '0')}@example.test`
  await expect(page.locator(`[data-contact-jid="${lastOffline}"]`)).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
  const search = page.getByPlaceholder('Search contacts...')
  await search.fill(lastContact)
  await expect(rows).toHaveCount(1)
  // Return to the sidebar's keyboard focus zone before navigating its rows.
  await search.press('Shift+Tab')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: lastContact, exact: true })).toBeVisible()
  await search.fill('')
  // Move beyond the initial window with real keys, not a DOM scroll on an
  // already-mounted row; the selected row must be revealed by the virtualizer.
  await search.press('Shift+Tab')
  for (let i = 0; i < MAX_SUGGESTIONS + 5; i++) await page.keyboard.press('ArrowDown')
  const selected = page.locator('[data-contact-jid].keyboard-focus-row')
  await expect(selected).toBeVisible()
  await expect.poll(() => rows.count()).toBeLessThan(MAX_SUGGESTIONS)
})
