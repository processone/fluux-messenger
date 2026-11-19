/**
 * Shared modal frost in the BUILT app.
 *
 * Every dialog renders through <ModalOverlay>: a `.modal-scrim` layer that frosts the app
 * behind it, and a `.fluux-glass` panel. Chromium and Firefox read only the unprefixed
 * `backdrop-filter`; WebKit reads either spelling. The production CSS minifier (Lightning
 * CSS, run by `vite build`) keeps only the `-webkit-` copy when it follows the unprefixed
 * declaration in a rule. A source-order slip in src/index.css therefore leaves Chromium
 * with no blur at all, the conversation sharp behind the dialog, while WebKit and the dev
 * server still frost. Only a built bundle shows it, so this suite reads computed styles
 * against the build the e2e config serves by default.
 *
 * The opt-outs ride on the same rules: once the unprefixed declarations survive, the
 * `none` overrides must survive too, or Chromium would blur where the user asked for a
 * solid surface.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const DEMO_URL = '/demo.html?tutorial=false'

/** Accessible name of the sidebar button that opens a shared dialog. */
const NEW_MESSAGE = 'New message'

/**
 * What each OS's browser reports in `navigator`. The app reads these to pick the modal
 * surface (src/platform detectOS): Linux keeps a solid panel, macOS gets the liquid tier.
 * Desktop Chrome's device profile reports Windows, so both values are set explicitly.
 */
const OS_NAVIGATOR = {
  macos: { platform: 'MacIntel', system: 'Macintosh; Intel Mac OS X 10_15_7' },
  linux: { platform: 'Linux x86_64', system: 'X11; Linux x86_64' },
} as const

type Os = keyof typeof OS_NAVIGATOR
type Transparency = 'full' | 'reduced'

/** Matches a computed backdrop filter that actually blurs. */
const BLURS = /blur\(/

async function openSharedDialog(
  page: Page,
  os: Os,
  transparency: Transparency,
): Promise<{ panel: Locator, scrim: Locator }> {
  await page.addInitScript(({ navigatorValues, mode }) => {
    const userAgent = navigator.userAgent.replace(/\([^)]*\)/, `(${navigatorValues.system})`)
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => navigatorValues.platform, configurable: true })
    Object.defineProperty(Navigator.prototype, 'userAgent', { get: () => userAgent, configurable: true })
    localStorage.setItem('fluux-transparency', mode)
  }, { navigatorValues: OS_NAVIGATOR[os], mode: transparency })
  await bootDemo(page, DEMO_URL)
  await expect(page.locator('html')).toHaveAttribute('data-platform', os)
  await expect(page.locator('html')).toHaveAttribute('data-transparency', transparency)

  await page.getByRole('button', { name: NEW_MESSAGE, exact: true }).first().click()
  const dialog = page.locator('[data-modal="true"]')
  const panel = dialog.locator('.fluux-glass')
  await expect(panel).toBeVisible()
  return { panel, scrim: dialog.locator('.modal-scrim') }
}

test('a shared dialog frosts the conversation behind it', async ({ page }) => {
  const { panel, scrim } = await openSharedDialog(page, 'macos', 'full')
  await expect(scrim).toHaveCSS('backdrop-filter', BLURS)
  await expect(panel).toHaveCSS('backdrop-filter', BLURS)
})

test('reduced transparency keeps the shared dialog solid', async ({ page }) => {
  const { panel, scrim } = await openSharedDialog(page, 'macos', 'reduced')
  await expect(scrim).toHaveCSS('backdrop-filter', 'none')
  await expect(panel).toHaveCSS('backdrop-filter', 'none')
})

test('Linux keeps the shared dialog panel solid over a frosted scrim', async ({ page }) => {
  const { panel, scrim } = await openSharedDialog(page, 'linux', 'full')
  await expect(scrim).toHaveCSS('backdrop-filter', BLURS)
  await expect(panel).toHaveCSS('backdrop-filter', 'none')
})
