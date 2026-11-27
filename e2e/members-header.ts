import { readFileSync } from 'node:fs'
import { expect, test, type Locator } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { navigateToStressRoom } from './harness/scrollHarness'
import { ROOM_JID } from '../apps/fluux/src/demo/constants'

const locales = Object.fromEntries(['en', 'fr'].map(lang => [lang,
  JSON.parse(readFileSync(new URL(`../apps/fluux/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8')),
]))

test.use({ reducedMotion: 'reduce' })

// The accepted docked-header fix requires visible room identity, contained controls
// and an unobscured Members heading, not merely a non-overflowing outer header.
async function containedHeader(toggle: Locator, heading: Locator) {
  await expect.poll(() => toggle.evaluate(button => {
    const header = button.closest('header')!
    const title = header.querySelector('[data-testid="room-info-area"]')!
    const name = title.querySelector('span[aria-hidden="true"]')!
    const bounds = header.getBoundingClientRect()
    const inside = (el: Element) => {
      const rect = el.getBoundingClientRect()
      return rect.left >= bounds.left && rect.right <= bounds.right &&
        rect.top >= bounds.top && rect.bottom <= bounds.bottom
    }
    return title.getBoundingClientRect().width >= parseFloat(getComputedStyle(name).fontSize) &&
      inside(title) && inside(button) && title.getBoundingClientRect().right <= button.getBoundingClientRect().left &&
      Array.from(button.children).every(el =>
        getComputedStyle(el).display === 'none' || inside(el))
  }), 'room name has readable space and the complete toggle stays in its header').toBe(true)
  await expect.poll(() => heading.evaluate(el => {
    const rect = el.getBoundingClientRect()
    const panelHeader = el.parentElement!.getBoundingClientRect()
    return rect.left >= panelHeader.left && rect.right <= panelHeader.right &&
      rect.top >= panelHeader.top && rect.bottom <= panelHeader.bottom &&
      [0.1, 0.5, 0.9].every(fraction => el.contains(document.elementFromPoint(
        rect.left + rect.width * fraction, rect.top + rect.height / 2,
      )))
  }), 'Members heading is inside its panel and no control covers it').toBe(true)
}

for (const lang of ['en', 'fr']) {
  for (const mode of ['light', 'dark']) {
    test(`${lang} ${mode}: docked Members leaves room identity and both close controls usable`, async ({ page }) => {
      const words = locales[lang]
      await page.setViewportSize({ width: 1024, height: 812 })
      await page.addInitScript(lang => localStorage.setItem('i18nextLng', lang), lang)
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(mode => {
        const w = window as any
        w.__demoClient.stopAnimation()
        w.__settingsStore.getState().setThemeMode(mode)
      }, mode)
      await navigateToStressRoom(page, false, ROOM_JID)
      const show = page.getByRole('button', { name: words.rooms.showMembers, exact: true })
      const hide = page.getByRole('button', { name: words.rooms.hideMembers, exact: true })
      const heading = page.getByRole('heading', { name: words.rooms.members, exact: true })
      await show.click()
      await expect(heading).toBeVisible()
      const sidebar = page.locator('.chrome-sidebar')
      const handle = sidebar.locator('[role="separator"][aria-orientation="vertical"]')
      const box = await handle.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(400, box!.y + box!.height / 2)
      await page.mouse.up()
      await expect(sidebar).toHaveCSS('width', '400px')

      // The first case is the reported failure; the other two were unaffected controls.
      for (const [width, text] of [[1024, 150], [1024, 100], [1280, 150]]) {
        await page.setViewportSize({ width, height: 812 })
        await page.evaluate(text => (window as any).__settingsStore.getState().setFontSize(text), text)
        for (const findOpen of [true, false]) {
          if (findOpen) await page.keyboard.press('Control+f')
          else await page.locator('[data-find-on-page-bar] input').press('Escape')
          await expect(page.locator('[data-find-on-page-bar]')).toHaveCount(findOpen ? 1 : 0)
          await containedHeader(hide, heading)
          if (process.env.FLUUX_MEMBERS_HEADER_PROOF) {
            await page.screenshot({ path: test.info().outputPath(`members-${width}-${text}-find-${findOpen}.png`) })
          }
          await page.getByRole('button', { name: words.rooms.closePanel, exact: true }).click()
          await expect(heading).toHaveCount(0)
          await show.click()
          await expect(heading).toBeVisible()
          await hide.click()
          await expect(heading).toHaveCount(0)
          await show.focus()
          await page.keyboard.press('Enter')
          await expect(heading).toBeVisible()
          await hide.focus()
          await page.keyboard.press('Space')
          await expect(heading).toHaveCount(0)
          await show.click()
          await containedHeader(hide, heading)
        }
      }
    })
  }
}
