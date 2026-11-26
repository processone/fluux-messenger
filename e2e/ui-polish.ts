import { readFileSync } from 'node:fs'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { syncEngineGeometry } from './harness/compositorSync'
import { activateChat, navigateToStressRoom } from './harness/scrollHarness'
import { ROOM_JID } from '../apps/fluux/src/demo/constants'

const locales = Object.fromEntries(['en', 'fr'].map(lang => [lang,
  JSON.parse(readFileSync(new URL(`../apps/fluux/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8')),
]))
const previewCopy = { en: 'Message previews appear here.', fr: 'L’aperçu des messages s’affiche ici.' }

test.use({ reducedMotion: 'reduce' })

async function boot(page: Page, lang: string, mode: string) {
  await page.addInitScript(lang => localStorage.setItem('i18nextLng', lang), lang)
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(mode => {
    const w = window as any
    w.__demoClient.stopAnimation()
    w.__settingsStore.getState().setThemeMode(mode)
  }, mode)
}

async function capture(page: Page, name: string) {
  if (process.env.FLUUX_UI_POLISH_PROOF) {
    await page.screenshot({ path: test.info().outputPath(name + '.png') })
  }
}

async function findGeometry(input: Locator, singleRow = false) {
  await expect(input).toBeFocused()
  await syncEngineGeometry(input.page())
  // Notices follow a grown bar a few frames later, and WebKit still lays them out at the old place,
  // over the bar, after their style has changed (the reduced-motion rule keeps a short transition).
  await expect.poll(() => input.evaluate(el => {
    const notices = document.querySelector('[data-toast-stack]')
    return !notices || notices.getBoundingClientRect().top >= el.closest('[data-find-on-page-bar]')!.getBoundingClientRect().bottom
  }), 'notices are laid out below the Find bar').toBe(true)
  expect(await input.evaluate((el, singleRow) => {
    const container = el.closest('[data-find-on-page-bar]')!
    const bar = container.getBoundingClientRect()
    const pane = container.parentElement!.parentElement!.getBoundingClientRect()
    const field = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
    const font = parseFloat(getComputedStyle(document.documentElement).fontSize)
    const uncovered = (target: Element) => {
      const rect = target.getBoundingClientRect()
      return [0.25, 0.5, 0.75].every(fraction => target.contains(
        document.elementFromPoint(rect.left + rect.width * fraction, rect.top + rect.height / 2),
      ))
    }
    return uncovered(el) && style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 &&
      field.width >= 4 * font && field.left - ring >= pane.left && field.right + ring <= pane.right &&
      field.top - ring >= bar.top && field.bottom + ring <= bar.bottom &&
      bar.left >= pane.left && bar.right <= pane.right &&
      Array.from(container.querySelectorAll('button, span')).every(control => {
        const rect = control.getBoundingClientRect()
        return uncovered(control) && rect.left >= bar.left && rect.right <= bar.right && rect.top >= bar.top && rect.bottom <= bar.bottom &&
          control.scrollWidth <= control.clientWidth && control.scrollHeight <= control.clientHeight &&
          (!singleRow || Math.abs((rect.top + rect.bottom) / 2 - (field.top + field.bottom) / 2) <= 1)
      })
  }, singleRow)).toBe(true)
}

async function fullDescription(description: Locator) {
  await expect.poll(() => description.evaluate(el => {
    const style = getComputedStyle(el)
    const rect = el.getBoundingClientRect()
    const header = el.parentElement!.parentElement!.getBoundingClientRect()
    return style.whiteSpace !== 'nowrap' && el.scrollHeight <= el.clientHeight &&
      el.scrollWidth <= el.clientWidth && rect.bottom <= header.bottom && rect.top >= header.top
  })).toBe(true)
}

for (const lang of ['en', 'fr'] as const) {
  for (const mode of ['light', 'dark']) {
    const words = locales[lang]
    test(`${lang} ${mode}: Find fits and preserves keyboard navigation`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 })
      await boot(page, lang, mode)
      for (const caller of ['chat', 'room']) {
        if (caller === 'chat') await activateChat(page, 'emma@fluux.chat')
        else await navigateToStressRoom(page, false, ROOM_JID)
        await page.keyboard.press('Control+f')
        const bar = page.locator('[data-find-on-page-bar]')
        const input = bar.locator('input')
        await expect(input).toBeFocused()
        await expect(input).not.toHaveCSS('outline-style', 'none')
        await expect(input).toHaveAttribute('placeholder', words.shortcuts.findInConversation)
        await expect(bar.getByTitle(`${words.shortcuts.previousMatch} (Shift+Enter)`)).toBeVisible()
        await expect(bar.getByTitle(`${words.shortcuts.nextMatch} (Enter)`)).toBeVisible()
        await expect(bar.getByTitle(`${words.common.close} (Esc)`)).toBeVisible()
        for (const width of [320, 375, 1280]) {
          await page.setViewportSize({ width, height: 812 })
          for (const query of ['', 'the', 'quartzbadger']) {
            await input.fill(query)
            if (query === 'quartzbadger') {
              await expect(bar.getByText(words.search.noResults, { exact: true })).toBeVisible()
              await expect(bar.getByTitle(`${words.shortcuts.nextMatch} (Enter)`)).toBeDisabled()
            }
            if (query === 'the') await expect(bar.locator('span')).toHaveText(/\d+\/\d+/)
            await findGeometry(input, width >= 375)
            if (query === 'quartzbadger') {
              if (width >= 375) {
                expect(await bar.locator('span').evaluate(el => el.clientHeight)).toBe(
                  await bar.locator('span').evaluate(el => parseFloat(getComputedStyle(el).lineHeight)),
                )
              }
              await capture(page, `find-${caller}-${lang}-${mode}-${width}`)
            }
          }
        }
        await page.setViewportSize({ width: 320, height: 812 })
        const baseFont = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
        await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(150))
        await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont * 1.5}px`)
        for (const query of ['', 'the', 'quartzbadger']) {
          await input.fill(query)
          if (query === 'quartzbadger') await expect(bar.locator('span')).toHaveText(words.search.noResults)
          if (query === 'the') await expect(bar.locator('span')).toHaveText(/\d+\/\d+/)
          await findGeometry(input)
          await capture(page, `find-${caller}-${lang}-${mode}-320-large-${query || 'empty'}`)
        }
        await input.fill('the')
        // A new query exposes its count before the newest-match selection commits.
        let matchCount = 0
        await expect.poll(async () => {
          const [current, total] = (await bar.locator('span').innerText()).split('/').map(Number)
          if (total <= 1 || current !== total) return false
          matchCount = total
          return true
        }).toBe(true)
        await input.press('Enter')
        await expect(bar.locator('span')).toHaveText(`1/${matchCount}`)
        await input.press('Shift+Enter')
        await expect(bar.locator('span')).toHaveText(`${matchCount}/${matchCount}`)
        await input.press('Escape')
        await expect(bar).toHaveCount(0)
        await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(100))
        await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont}px`)
      }
    })

    test(`${lang} ${mode}: Find fits beside docked Members and a wide sidebar`, async ({ page }) => {
      await page.setViewportSize({ width: 1024, height: 812 })
      await boot(page, lang, mode)
      await navigateToStressRoom(page, false, ROOM_JID)
      await page.getByRole('button', { name: words.rooms.showMembers, exact: true }).click()
      await expect(page.getByRole('heading', { name: words.rooms.members, exact: true })).toBeVisible()
      const sidebar = page.locator('.chrome-sidebar')
      const handle = sidebar.locator('[role="separator"][aria-orientation="vertical"]')
      const box = await handle.boundingBox()
      expect(box).not.toBeNull()
      await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
      await page.mouse.down()
      await page.mouse.move(400, box!.y + box!.height / 2)
      await page.mouse.up()
      await expect(sidebar).toHaveCSS('width', '400px')
      const baseFont = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
      await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(150))
      await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont * 1.5}px`)
      await page.keyboard.press('Control+f')
      const bar = page.locator('[data-find-on-page-bar]')
      const input = bar.locator('input')
      // WebKit updates rem-based panel widths a frame after reporting the new root font size.
      await expect.poll(() => bar.evaluate(el => el.parentElement!.parentElement!.getBoundingClientRect().width)).toBeLessThan(250)
      for (const query of ['', 'the', 'quartzbadger']) {
        await input.fill(query)
        if (query === 'the') await expect(bar.locator('span')).toHaveText(/\d+\/\d+/)
        if (query === 'quartzbadger') await expect(bar.locator('span')).toHaveText(words.search.noResults)
        await findGeometry(input)
        await capture(page, `find-docked-${lang}-${mode}-${query || 'empty'}`)
      }
      await input.press('Escape')
      await expect(bar).toHaveCount(0)
    })

    test(`${lang} ${mode}: Members backdrop covers Find on tablets`, async ({ page }) => {
      await page.setViewportSize({ width: 768, height: 812 })
      await boot(page, lang, mode)
      await navigateToStressRoom(page, false, ROOM_JID)
      await page.keyboard.press('Control+f')
      const bar = page.locator('[data-find-on-page-bar]')
      const input = bar.locator('input')
      for (const width of [768, 1023]) {
        await page.setViewportSize({ width, height: 812 })
        await input.fill('quartzbadger')
        await expect(bar.locator('span')).toHaveText(words.search.noResults)
        await findGeometry(input)
        const box = await input.boundingBox()
        expect(box).not.toBeNull()
        const point = { x: box!.x + box!.width / 4, y: box!.y + box!.height / 2 }
        await page.getByRole('button', { name: words.rooms.showMembers, exact: true }).click()
        const members = page.getByRole('heading', { name: words.rooms.members, exact: true })
        await expect(members).toBeVisible()
        await syncEngineGeometry(page)
        const panel = await members.locator('..').locator('..').boundingBox()
        expect(panel).not.toBeNull()
        expect(point.x).toBeLessThan(panel!.x)
        await capture(page, `find-members-open-${lang}-${mode}-${width}`)
        await page.mouse.click(point.x, point.y)
        await expect(members).toHaveCount(0)
        await expect(input).toHaveValue('quartzbadger')
        await input.click()
        await findGeometry(input)
        await capture(page, `find-members-dismissed-${lang}-${mode}-${width}`)
      }
      await input.press('Escape')
      await expect(bar).toHaveCount(0)
    })

    test(`${lang} ${mode}: compact settings show full descriptions`, async ({ page }) => {
      await page.setViewportSize({ width: 375, height: 812 })
      await boot(page, lang, mode)
      await page.locator('[data-nav="settings"]').click()
      for (const category of ['appearance', 'accessibility', 'notifications']) {
        await page.getByRole('button', { name: words.settings.categories[category], exact: true }).click()
        const title = page.getByRole('heading', { name: words.settings.categories[category], exact: true, level: 2 })
        const description = title.locator('..').locator('p')
        await expect(description).toHaveText(words.settings.categoryDescriptions[category])
        await fullDescription(description)
        await capture(page, `settings-${category}-${lang}-${mode}-375`)
        const baseFont = await page.locator('html').evaluate(el => parseFloat(getComputedStyle(el).fontSize))
        await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(150))
        await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont * 1.5}px`)
        await fullDescription(description)
        await capture(page, `settings-${category}-${lang}-${mode}-large`)
        const back = page.getByRole('button', { name: words.common.back, exact: true })
        await expect(back).toBeVisible()
        await back.click()
        await page.evaluate(() => (window as any).__settingsStore.getState().setFontSize(100))
        await expect(page.locator('html')).toHaveCSS('font-size', `${baseFont}px`)
      }
      await page.setViewportSize({ width: 1280, height: 812 })
      await page.getByRole('button', { name: words.settings.categories.accessibility, exact: true }).click()
      const title = page.getByRole('heading', { name: words.settings.categories.accessibility, level: 2, exact: true })
      expect(await title.evaluate(el => el.parentElement!.parentElement!.getBoundingClientRect().height)).toBe(56)
      await capture(page, `settings-${lang}-${mode}-1280`)
    })

    test(`${lang} ${mode}: Search preview stays truthful until a result is selected`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 812 })
      await boot(page, lang, mode)
      await page.locator('[data-nav="search"]').click()
      const field = page.getByPlaceholder(words.search.placeholder, { exact: true })
      await expect(field).toBeFocused()
      const description = page.getByText(previewCopy[lang], { exact: true })
      await expect(description).toBeVisible()
      await capture(page, `search-empty-${lang}-${mode}`)
      await field.fill('quartzbadger')
      await expect(page.getByText(words.search.panel.localEmpty, { exact: true })).toBeVisible()
      await expect(description).toBeVisible()
      await expect(field).toBeFocused()
      await expect(page.getByRole('button', { name: words.search.searchServer, exact: true })).toBeVisible()
      await capture(page, `search-no-results-${lang}-${mode}`)
      const hit = await page.evaluate(() => {
        const state = (window as any).__chatStore.getState()
        const conversation = state.conversations.get('emma@fluux.chat')
        const message = state.messages.get(conversation.id).find((message: { id: string }) => message.id === 'demo-emma-0c')
        return { body: message.body as string, name: conversation.name as string }
      })
      await field.fill('CSS transforms')
      const result = page.locator('[data-search-result-id]').filter({ hasText: hit.body })
      await expect(result).toBeVisible()
      await result.click()
      await expect(description).toHaveCount(0)
      const banner = page.getByText(words.search.previewBanner, { exact: true })
      await expect(banner).toBeVisible()
      const preview = banner.locator('..').locator('..').locator('..')
      await expect(preview.locator('header').getByText(hit.name, { exact: true })).toBeVisible()
      await expect(preview.locator('[data-message-list]').getByText(hit.body, { exact: true })).toBeVisible()
      await capture(page, `search-selected-${lang}-${mode}`)
    })
  }
}

for (const lang of ['en', 'fr']) {
  for (const mode of ['light', 'dark']) {
    test.describe(`${lang} ${mode}: touch settings`, () => {
      test.use({ hasTouch: true })
      test('Back keeps its touch target without enlarging short headers', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 })
        await boot(page, lang, mode)
        expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
        const words = locales[lang]
        await page.locator('[data-nav="settings"]').click()
        await page.getByRole('button', { name: words.settings.categories.language, exact: true }).click()
        const title = page.getByRole('heading', { name: words.settings.categories.language, exact: true, level: 2 })
        const description = title.locator('..').locator('p')
        await fullDescription(description)
        expect(await description.evaluate(el => el.clientHeight)).toBe(
          await description.evaluate(el => parseFloat(getComputedStyle(el).lineHeight)),
        )
        const header = title.locator('..').locator('..')
        expect(await header.evaluate(el => el.getBoundingClientRect().height)).toBe(56)
        const back = header.getByRole('button', { name: words.common.back, exact: true })
        expect(await back.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
        expect(await back.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44)
        await capture(page, `settings-short-touch-${lang}-${mode}`)
        await back.click()
        await page.getByRole('button', { name: words.settings.categories.encryption, exact: true }).click()
        for (const method of ['openpgp', 'omemo']) {
          const name = words.settings.encryption[`${method}Name`]
          await page.getByRole('button', { name: new RegExp(`^${name}`) }).click()
          const methodTitle = page.getByRole('heading', { name, exact: true, level: 2 })
          const methodHeader = methodTitle.locator('..').locator('..')
          await expect(methodTitle.locator('..').locator('p')).toHaveCount(0)
          expect(await methodHeader.evaluate(el => el.getBoundingClientRect().height)).toBe(56)
          const methodBack = methodHeader.getByRole('button', { name: words.common.back, exact: true })
          expect(await methodBack.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
          expect(await methodBack.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(44)
          await capture(page, `settings-${method}-touch-${lang}-${mode}`)
          await methodBack.click()
          await expect(page.getByRole('heading', { name: words.settings.categories.encryption, exact: true, level: 2 })).toBeVisible()
        }
      })
    })
  }
}
