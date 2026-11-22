/** Accepted focus design: browser modality owns the single outline; list
 * selection owns an inset outline independently of the active conversation.
 * Real demo controls and palettes, no synthetic HTML/CSS focus specimens.
 */
import { expect, test, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'
import { join } from 'node:path'

test.use({ viewport: { width: 1280, height: 900 } })

async function boot(page: Page, mode: 'light' | 'dark') {
  await page.addInitScript(mode => localStorage.setItem('fluux-theme', mode), mode)
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as any).__demoClient.stopAnimation())
  // The demo reports ready before startup has finished moving focus. Tab skips zones that
  // are not mounted, so a first conversation opening between two presses changes where the
  // next one lands, and the shell takes focus once shortly after it mounts.
  await activateChat(page, 'ava@fluux.chat')
  await expect(page.locator('.chrome-shell')).toBeFocused()
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
  const pane = page.locator('.focus-zone').first()
  await tabTo(page, pane)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.keyboard-focus-row')).toHaveCSS('outline-color', highlight)
  await page.getByRole('button', { name: 'New message', exact: true }).first().click()
  const field = page.locator('[data-modal="true"] input').first()
  await field.click()
  await expect(field).toHaveCSS('outline-color', highlight)
})

// Exercise useTheme's browser-resolved path, not only the pure guard. The custom
// fixture is an installed copy of a shipped palette, as a theme plugin supplies.
test('theme, accent and system-mode changes refresh the guarded token', async ({ page }) => {
  await boot(page, 'dark')
  await page.evaluate(() => {
    const state = (window as any).__themeStore.getState()
    const solarized = state.getAllThemes().find((t: any) => t.id === 'solarized')
    state.installTheme({ ...solarized, id: 'focus-proof-solarized', name: 'Solarized copy' })
    state.setActiveTheme('focus-proof-solarized')
  })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'focus-proof-solarized')
  const read = () => page.evaluate(() => {
    const root = document.documentElement
    const probe = document.createElement('span')
    document.body.appendChild(probe)
    // Resolve through real painted pixels, preserving every layer's alpha.
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    const rgb = (...layers: string[]) => {
      context.clearRect(0, 0, 1, 1)
      for (const token of layers) {
        probe.style.color = token.startsWith('--') ? `var(${token})` : token
        context.fillStyle = getComputedStyle(probe).color
        context.fillRect(0, 0, 1, 1)
      }
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    }
    const lum = (rgb: number[]) => {
      const c = rgb.map(v => v / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return c[0] * 0.2126 + c[1] * 0.7152 + c[2] * 0.0722
    }
    const ring = rgb('--fluux-focus-ring')
    const shell = ['Canvas', '--fluux-bg-primary']
    const panes = ['--fluux-chat-bg', '--fluux-sidebar-bg'].map(token => [...shell, token])
    const dialogs = panes.map(layers => [...layers, '--fluux-modal-bg'])
    const popovers = [...panes, ...dialogs].map(layers => [...layers, '--fluux-bg-float'])
    const bases = [...panes, ...dialogs, ...popovers]
    const ratios = [...bases, ...bases.map(layers => [...layers, '--fluux-bg-hover'])].map(layers => {
      const a = lum(ring), b = lum(rgb(...layers))
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


// These actual inputs share one pointer exception; none is a text editor.
// A same-control click must clear keyboard styling even when Blink retains
// :focus-visible (checkbox/radio/range are not the text-input exception).
test('clicked checkbox and slider do not retain keyboard rings', async ({ page }) => {
  await page.goto('/')
  const checkbox = page.locator('input[type="checkbox"]').first()
  // A cold dev server can take longer than the default 5s to serve the login page's modules.
  await expect(checkbox).toBeVisible({ timeout: test.info().timeout })
  await page.keyboard.press('Tab')
  await checkbox.focus()
  await expect(checkbox).toHaveCSS('outline-width', '2px')
  await checkbox.click()
  await expect(checkbox).toHaveCSS('outline-style', 'none')
  await boot(page, 'dark')
  await page.evaluate(() => { location.hash = '/settings/accessibility' })
  const slider = page.locator('#accessibility-font-size')
  await expect(slider).toBeVisible()
  await page.keyboard.press('Tab')
  await slider.focus()
  await expect(slider).toHaveCSS('outline-width', '2px')
  await slider.click()
  await expect(slider).toHaveCSS('outline-style', 'none')
})

test('handled presence arrows restore keyboard modality and inset menu focus', async ({ page }) => {
  await boot(page, 'dark')
  await page.getByTestId('account-row').click()
  await expect(page.locator('html')).toHaveAttribute('data-focus-modality', 'pointer')
  // Focus enters the menu on the current presence a frame after opening; arrow only once it has.
  await expect(page.getByRole('menuitemradio', { name: 'Online', exact: true })).toBeFocused()
  // The account menu moves focus itself on arrow keys, and the key marks keyboard modality.
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('html')).toHaveAttribute('data-focus-modality', 'keyboard')
  const option = page.getByRole('menuitemradio', { name: 'Away', exact: true })
  await expect(option).toBeFocused()
  await expect(option).toHaveCSS('outline-width', '2px')
  await expect(option).toHaveCSS('outline-offset', '-2px')
})

// Render the actual custom-chrome controls in the application entry, with only
// native window IPC replaced. This proves focus CSS, not Windows operations,
// signing, keychain access or native window-manager integration.
test('custom window controls participate in the shared inset keyboard ring', async ({ page, browserName }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'Win32', configurable: true })
    Object.defineProperty(Navigator.prototype, 'userAgent', {
      get: () => 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36', configurable: true,
    })
    localStorage.setItem('fluux:disable-tcp-proxy', 'true')
    const callbacks = new Map<number, unknown>()
    let next = 0
    ;(window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (callback: unknown) => { callbacks.set(++next, callback); return next },
      unregisterCallback: (id: number) => callbacks.delete(id),
      convertFileSrc: (file: string) => file,
      invoke: async (command: string) => {
        if (command === 'plugin:window|is_decorated' || command === 'plugin:window|is_fullscreen' || command === 'plugin:window|is_maximized') return false
        if (command === 'plugin:event|listen') return ++next
        return null
      },
    }
    ;(window as any).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
  })
  await page.goto('/')
  const controls = page.locator('.window-controls .window-control')
  // The entry imports main asynchronously after its boot checks; on the dev
  // launcher that module graph can still be loading after the default 5s
  // assertion budget. Wait for actual controls within the project's test gate.
  await expect(controls).toHaveCount(3, { timeout: test.info().timeout })
  for (const mode of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: mode })
    if (mode === 'light') await expect(page.locator('html')).toHaveClass(/light/)
    else await expect(page.locator('html')).not.toHaveClass(/light/)
    for (let i = 0; i < await controls.count(); i++) {
      const button = controls.nth(i)
      await page.keyboard.press('Tab')
      await button.focus()
      await expect(button).toHaveCSS('outline-style', 'solid')
      await expect(button).toHaveCSS('outline-width', '2px')
      await expect(button).toHaveCSS('outline-offset', '-2px')
      console.log('Window focus', browserName, mode, await button.evaluate(el => {
        const style = getComputedStyle(el)
        return { control: el.getAttribute('aria-label'), width: style.outlineWidth, offset: style.outlineOffset, color: style.outlineColor }
      }))
      if (process.env.FLUUX_FOCUS_PROOF) {
        await page.locator('.window-controls').screenshot({ path: join(process.env.FLUUX_FOCUS_PROOF, `window-${browserName}-${mode}-${i}.png`) })
      }
      await button.click()
      await expect(button).toHaveCSS('outline-style', 'none')
    }
  }
})
