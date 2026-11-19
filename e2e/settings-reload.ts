import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { bootDemo, reloadDemo } from './harness/demoBoot'

const en = JSON.parse(readFileSync(new URL('../apps/fluux/src/i18n/locales/en.json', import.meta.url), 'utf8'))

test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' })

/**
 * A reload restores the view saved in session storage (ChatLayout's mount-time restore). The
 * saved view must carry the open Settings page, or the restore replaces #/settings/encryption
 * with #/settings and the reload reopens Profile.
 */
test('a reload on a Settings page reopens that page, not Profile', async ({ page }) => {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.getByRole('button', { name: en.sidebar.settings, exact: true }).click()
  await page.getByRole('button', { name: en.settings.categories.encryption, exact: true }).click()
  await expect(page.getByRole('heading', { name: en.settings.categories.encryption, level: 2 })).toBeVisible()

  // The shell saves the view to restore from an effect after the page shows; reload once it has.
  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('xmpp-view-state'))
    .map(key => JSON.parse(sessionStorage.getItem(key)!) as { sidebarView: string; settingsCategory?: string | null })
    .find(view => view.sidebarView === 'settings')?.settingsCategory ?? null),
  'the shell saved the open Settings page as the view to restore').toBe('encryption')

  // reloadDemo returns once the shell's startup navigation, the view restore included, is over.
  await reloadDemo(page)

  expect(await page.evaluate(() => location.hash)).toBe('#/settings/encryption')
  await expect(page.getByRole('heading', { name: en.settings.categories.encryption, level: 2 })).toBeVisible()
  await expect(page.getByRole('heading', { name: en.settings.categories.profile, level: 2 })).toHaveCount(0)
})

/** The Encryption overview has a screen per method; a reload on one must reopen that screen, not the overview. */
test('a reload on an Encryption method screen reopens that screen', async ({ page }) => {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.getByRole('button', { name: en.sidebar.settings, exact: true }).click()
  await page.getByRole('button', { name: en.settings.categories.encryption, exact: true }).click()
  await page.getByRole('button', { name: /^OMEMO/ }).click()
  await expect(page.getByRole('heading', { name: en.settings.encryption.omemoName, level: 2 })).toBeVisible()

  await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage)
    .filter(key => key.startsWith('xmpp-view-state'))
    .map(key => JSON.parse(sessionStorage.getItem(key)!) as { sidebarView: string; settingsSubPage?: string | null })
    .find(view => view.sidebarView === 'settings')?.settingsSubPage ?? null),
  'the shell saved the open method screen').toBe('omemo')

  await reloadDemo(page)

  expect(await page.evaluate(() => location.hash)).toBe('#/settings/encryption/omemo')
  await expect(page.getByRole('heading', { name: en.settings.encryption.omemoName, level: 2 })).toBeVisible()
})
