import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

// The approved pre-release UI polish owns narrow Find geometry, compact settings
// description visibility and truthful unselected Search copy. Use the real demo UI.
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
    await page.screenshot({ path: join(process.env.FLUUX_UI_POLISH_PROOF, name + '.png') })
  }
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
      await activateChat(page, 'emma@fluux.chat')
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
          expect(await input.evaluate(el => {
            const bar = el.closest('[data-find-on-page-bar]')!.getBoundingClientRect()
            const pane = el.closest('[data-find-on-page-bar]')!.parentElement!.parentElement!.getBoundingClientRect()
            const field = el.getBoundingClientRect()
            const style = getComputedStyle(el)
            const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset)
            return field.width > 0 && field.left - ring >= pane.left && field.right + ring <= pane.right &&
              bar.left >= pane.left && bar.right <= pane.right
          })).toBe(true)
          if (query === 'quartzbadger') await capture(page, `find-${lang}-${mode}-${width}`)
        }
      }
      await input.fill('the')
      await expect(bar.locator('span')).toHaveText(/\d+\/\d+/)
      const count = (await bar.locator('span').innerText()).split('/').map(Number)
      expect(count[1]).toBeGreaterThan(1)
      await input.press('Enter')
      await expect(bar.locator('span')).toHaveText(`${count[0] % count[1] + 1}/${count[1]}`)
      await input.press('Shift+Enter')
      await expect(bar.locator('span')).toHaveText(count.join('/'))
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
      await expect(page.getByText(words.search.noResults, { exact: true })).toBeVisible()
      await expect(description).toBeVisible()
      await expect(field).toBeFocused()
      await expect(page.getByRole('button', { name: words.search.searchServer, exact: true })).toBeVisible()
      await capture(page, `search-no-results-${lang}-${mode}`)
      await field.fill('the')
      const result = page.locator('[data-search-result-id]').first()
      await expect(result).toBeVisible()
      await result.click()
      await expect(description).toHaveCount(0)
      await expect(page.locator('[data-message-list]')).toBeVisible()
      await capture(page, `search-selected-${lang}-${mode}`)
    })
  }
}
