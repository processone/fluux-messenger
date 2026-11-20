/** Accepted focus design: browser modality owns the single outline; list
 * selection owns an inset outline independently of the active conversation.
 * Real demo controls and palettes, no synthetic HTML/CSS focus specimens.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { join } from 'node:path'

test.use({ viewport: { width: 1280, height: 900 } })

async function boot(page: Page, mode: 'light' | 'dark') {
  await page.addInitScript(mode => localStorage.setItem('fluux-theme', mode), mode)
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as any).__demoClient.stopAnimation())
}

async function capture(page: Page, name: string) {
  if (process.env.FLUUX_FOCUS_PROOF) {
    await page.screenshot({ path: join(process.env.FLUUX_FOCUS_PROOF, name + '.png') })
  }
}

async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press('Tab')
    if (await target.evaluate(el => document.activeElement === el)) return
  }
  throw new Error('Control was not reachable by Tab')
}

for (const mode of ['light', 'dark'] as const) {
  test(`${mode}: launch gate, keyboard ring and pointer focus`, async ({ page }) => {
    await boot(page, mode)
    const rail = page.locator('[data-nav="messages"]')
    // Launch autofocus is silent even if the browser would mark it focus-visible.
    await rail.focus()
    await expect(rail).toHaveCSS('outline-style', 'none')
    await expect(page.locator('html')).not.toHaveClass(/user-interacted/)
    // The existing shell routes Tab between panes, not through rail/header
    // buttons. Keep that focus order: establish keyboard modality with a real
    // Tab, then exercise the rail's browser styling with programmatic focus.
    await page.keyboard.press('Tab')
    await rail.focus()
    await expect(rail).toBeFocused()
    await expect(rail).toHaveCSS('outline-width', '2px')
    await expect(rail).toHaveCSS('outline-offset', '2px')
    await expect(rail).toHaveCSS('box-shadow', 'none')
    await capture(page, `${mode}-rail-keyboard`)
    await rail.click()
    await expect(rail).toHaveCSS('outline-style', 'none')
    const button = page.getByRole('button', { name: 'New message', exact: true }).first()
    await page.keyboard.press('Tab')
    await button.focus()
    await expect(button).toHaveCSS('outline-width', '2px')
    await expect(button).toHaveCSS('outline-offset', '2px')
    await button.click()
    const field = page.locator('[data-modal="true"] input').first()
    await field.click()
    await expect(field).toHaveCSS('outline-width', '2px')
    await expect(field).toHaveCSS('outline-offset', '2px')
    await expect(field).toHaveCSS('box-shadow', 'none')
    await capture(page, `${mode}-dialog-field`)
    await page.keyboard.press('Escape')
    const pane = page.locator('.focus-zone').first()
    await pane.click({ position: { x: 2, y: 2 } })
    await expect(pane).toHaveCSS('outline-style', 'none')
    await capture(page, `${mode}-pointer-pane`)
  })

  test(`${mode}: arrow selection includes the active row without a hover edge`, async ({ page }) => {
    await boot(page, mode)
    const pane = page.locator('.focus-zone').first()
    await tabTo(page, pane)
    await expect(pane).toHaveCSS('outline-width', '1px')
    await expect(pane).toHaveCSS('outline-offset', '-1px')
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(pane).toBeFocused()
    await page.keyboard.press('ArrowDown')
    const row = page.locator('.sidebar-row.keyboard-focus-row')
    await expect(row).toHaveCount(1)
    await expect(row).toHaveCSS('outline-width', '2px')
    await expect(row).toHaveCSS('outline-offset', '-2px')
    await page.keyboard.press('Enter')
    // Activation must not hide the keyboard edge on the active conversation.
    await expect(row).toHaveCSS('outline-width', '2px')
    await capture(page, `${mode}-active-row`)
    await row.hover()
    await page.mouse.move(5, 5)
    const hovered = page.locator('.sidebar-row').last()
    await hovered.hover()
    await expect(page.locator('.sidebar-row.keyboard-focus-row')).toHaveCount(0)
    await expect(hovered).toHaveCSS('outline-style', 'none')
    await expect(hovered).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    await capture(page, `${mode}-hover-row`)
  })
}

test('forced colours keep the keyboard indicator', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'WebKit does not emulate forced colours')
  await page.emulateMedia({ forcedColors: 'active' })
  await boot(page, 'dark')
  const rail = page.locator('[data-nav="messages"]')
  await page.keyboard.press('Tab')
  await rail.focus()
  await expect(rail).toHaveCSS('outline-style', 'solid')
  await expect(rail).toHaveCSS('outline-width', '2px')
  const highlight = await page.evaluate(() => {
    const probe = document.createElement('span')
    probe.style.color = 'Highlight'
    document.body.appendChild(probe)
    const color = getComputedStyle(probe).color
    probe.remove()
    return color
  })
  await expect(rail).toHaveCSS('outline-color', highlight)
})

// Exercise useTheme's browser-resolved path, not only the pure guard. The custom
// fixture is an installed copy of a shipped palette, as a theme plugin supplies.
test('theme, accent and system-mode changes refresh the guarded token', async ({ page }) => {
  await boot(page, 'dark')
  await page.evaluate(() => {
    const state = (window as any).__themeStore.getState()
    const nord = state.getAllThemes().find((t: any) => t.id === 'nord')
    state.installTheme({ ...nord, id: 'focus-proof-nord', name: 'Nord copy' })
    state.setActiveTheme('focus-proof-nord')
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'focus-proof-nord')
  const read = () => page.evaluate(() => {
    const root = document.documentElement
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    const rgb = (token: string) => {
      probe.style.color = `var(${token})`
      return getComputedStyle(probe).color.match(/[\d.]+/g)!.slice(0, 3).map(Number)
    }
    const lum = (rgb: number[]) => {
      const c = rgb.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
    }
    const ring = rgb('--fluux-focus-ring')
    const ratios = ['--fluux-chat-bg', '--fluux-sidebar-bg', '--fluux-bg-hover', '--fluux-modal-bg', '--fluux-bg-float'].map(token => {
      const a = lum(ring), b = lum(rgb(token))
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
    })
    probe.remove()
    return { color: getComputedStyle(root).getPropertyValue('--fluux-focus-ring'), minimum: Math.min(...ratios) }
  })
  await expect.poll(async () => (await read()).minimum).toBeGreaterThanOrEqual(3)
  const original = (await read()).color
  await page.evaluate(() => {
    const state = (window as any).__themeStore.getState()
    state.setAccentPreset(state.getAccentPresets().find((p: any) => p.name === 'Pink'))
  })
  await expect.poll(async () => (await read()).color).not.toBe(original)
  await expect.poll(async () => (await read()).minimum).toBeGreaterThanOrEqual(3)
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.evaluate(() => (window as any).__settingsStore.getState().setThemeMode('system'))
  const dark = (await read()).color
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveClass(/light/)
  await expect.poll(async () => (await read()).color).not.toBe(dark)
  await expect.poll(async () => (await read()).minimum).toBeGreaterThanOrEqual(3)
})
