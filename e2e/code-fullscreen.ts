import { test, expect, devices, type Locator, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

// These unwrapped lines overflow a phone but fit a wide desktop panel, exposing
// phone readability and desktop preference changes with the same message.
const CODE = [
  'replace_keywords(Host, {Element1, Element2}, Keywords) when is_list(Element1) ->',
  '    {replace_keywords(Host, Element1, Keywords), Element2};',
  'replace_keywords(Host, {Element1, Element2}, Keywords) when is_list(Element2) ->',
  '    {Element1, replace_keywords(Host, Element2, Keywords)}.',
].join('\n')

const bounds = (target: Locator) => target.evaluate(element => {
  const { top, bottom, left, right, width, height } = element.getBoundingClientRect()
  return { top, bottom, left, right, width, height }
})

async function openCode(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(code => {
    const scope = window as unknown as {
      __demoClient: { stopAnimation: () => void; emitSDK: (event: string, payload: unknown) => void }
      __settingsStore: { getState: () => { setThemeMode: (mode: string) => void } }
    }
    scope.__demoClient.stopAnimation()
    scope.__settingsStore.getState().setThemeMode('dark')
    const jid = 'emma@fluux.chat'
    window.location.hash = '#/messages/' + encodeURIComponent(jid)
    scope.__demoClient.emitSDK('chat:message', {
      message: {
        id: 'fullscreen-code', stanzaId: 'fullscreen-code', from: jid, conversationId: jid,
        type: 'chat', timestamp: new Date(), isOutgoing: false, body: '```erlang\n' + code + '\n```',
      },
      isLiveArrival: true,
    })
  }, CODE)
  const expand = page.locator('[data-message-id="fullscreen-code"] button[title="Expand code"]').first()
  await expand.click()
  const modal = page.locator('[data-modal="true"]').filter({ has: page.locator('pre') })
  await expect(modal.locator('pre code span').first()).toBeVisible()
  await page.evaluate(() => {
    const scope = window as unknown as {
      __toastStore: { getState: () => { toasts: { id: string }[]; removeToast: (id: string) => void } }
    }
    const { toasts, removeToast } = scope.__toastStore.getState()
    for (const toast of toasts) removeToast(toast.id)
    return document.fonts.ready
  })
  await expect(page.locator('[data-toast-stack]')).toHaveCount(0)
  return {
    modal, expand,
    pre: modal.locator('pre'),
    title: modal.locator('h2'),
    close: modal.getByRole('button', { name: 'Close', exact: true }),
    wrap: modal.locator('button[aria-pressed]'),
    copy: modal.getByTitle('Copy code', { exact: true }),
  }
}

for (const mode of ['phone', 'phone-mouse', 'desktop', 'narrow-desktop', 'touch-desktop'] as const) {
  const phone = mode === 'phone' || mode === 'phone-mouse'
  const narrow = phone || mode === 'narrow-desktop'
  test.describe(mode, () => {
    test.use({
      hasTouch: mode === 'phone' || mode === 'touch-desktop',
      isMobile: phone,
      deviceScaleFactor: phone ? 3 : 1,
      userAgent: async ({ browserName }, use) => {
        const device = phone ? 'iPhone 16 Pro Max'
          : mode === 'touch-desktop' || browserName === 'chromium' ? 'Desktop Edge' : 'Desktop Safari'
        await use(devices[device].userAgent)
      },
    })
    test('code opening and controls', async ({ page, browserName }, testInfo) => {
      const portrait = narrow ? { width: 440, height: 956 } : { width: 1280, height: 800 }
      await page.setViewportSize(portrait)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      // WebKitGTK cannot emulate UIKit insets; the native simulator owns that proof.
      const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null
      const setInsets = async (top: number, bottom: number, left = 0, right = 0) => {
        await cdp?.send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top, topMax: top, bottom, bottomMax: bottom, left, leftMax: left, right, rightMax: right },
        })
      }
      const top = cdp ? 62 : 0
      const bottom = cdp ? 34 : 0
      await setInsets(top, bottom)
      const { modal, expand, pre, title, close, wrap, copy } = await openCode(page)
      for (const control of [close, wrap, copy]) await expect(control).toBeVisible()
      const capture = async (name: string) => {
        const geometry = {
          title: await bounds(title), close: await bounds(close),
          wrap: await bounds(wrap), copy: await bounds(copy),
          panel: await bounds(modal.locator('.fluux-glass')),
          code: await pre.evaluate(p => ({ width: p.clientWidth, scrollWidth: p.scrollWidth, text: p.textContent })),
          padding: await modal.locator('.fluux-glass').evaluate(panel => ({
            top: getComputedStyle(panel).paddingTop, bottom: getComputedStyle(panel).paddingBottom,
          })),
        }
        await testInfo.attach(`${name}-geometry`, { body: JSON.stringify({ mode, browserName, ...geometry }, null, 2), contentType: 'application/json' })
        await testInfo.attach(name, { body: await page.screenshot(), contentType: 'image/png' })
        return geometry
      }
      const opening = await capture('opening')
      expect(opening.code.text).toBe(CODE)
      if (phone) {
        expect.soft(opening.title.top).toBeGreaterThanOrEqual(top)
        expect.soft(opening.close.top).toBeGreaterThanOrEqual(top)
        for (const box of [opening.wrap, opening.copy]) expect.soft(box.bottom).toBeLessThanOrEqual(portrait.height - bottom)
        expect.soft(opening.code.scrollWidth).toBeLessThanOrEqual(opening.code.width + 1)
        await expect.soft(wrap).toHaveAttribute('aria-pressed', 'true')
      } else {
        expect(opening.padding).toEqual({ top: '0px', bottom: '0px' })
        await expect(pre).toHaveCSS('white-space', 'pre')
        await expect(wrap).toHaveAttribute('aria-pressed', 'false')
      }
      if (narrow) {
        expect(opening.panel).toEqual({ top: 0, bottom: 956, left: 0, right: 440, width: 440, height: 956 })
      } else {
        expect(opening.panel.top).toBeGreaterThan(0)
        expect(opening.panel.bottom).toBeLessThan(portrait.height)
      }
      if (!phone) await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
      await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'false')
      await expect(pre).toHaveCSS('white-space', 'pre')
      expect(await pre.textContent()).toBe(CODE)
      if (narrow) expect(await pre.evaluate(p => p.scrollWidth > p.clientWidth)).toBe(true)
      if (phone) {
        await setInsets(0, cdp ? 21 : 0, cdp ? 62 : 0, cdp ? 62 : 0)
        await page.setViewportSize({ width: 956, height: 440 })
        await expect(wrap).toHaveAttribute('aria-pressed', 'false')
        const landscape = await capture('landscape')
        expect(landscape.code.text).toBe(CODE)
        expect(landscape.panel.top).toBeGreaterThan(0)
        expect(landscape.panel.bottom).toBeLessThan(440)
        for (const box of [landscape.title, landscape.close, landscape.wrap, landscape.copy]) {
          expect.soft(box.left).toBeGreaterThanOrEqual(cdp ? 62 : 0)
          expect.soft(box.right).toBeLessThanOrEqual(956 - (cdp ? 62 : 0))
          expect.soft(box.bottom).toBeLessThanOrEqual(440 - (cdp ? 21 : 0))
        }
        await close.click()
        await expect(modal).toHaveCount(0)
        await expect(page.locator('[data-message-id="fullscreen-code"] pre').first()).toHaveCSS('white-space', 'pre')
        await expand.click()
        await expect(wrap).toHaveAttribute('aria-pressed', 'true')
        await expect(pre).toHaveCSS('white-space', 'pre-wrap')
        const freshLandscape = await capture('fresh-landscape')
        expect(freshLandscape.code.text).toBe(CODE)
        expect(freshLandscape.code.scrollWidth).toBeLessThanOrEqual(freshLandscape.code.width + 1)
        await wrap.click()
        await expect(wrap).toHaveAttribute('aria-pressed', 'false')
      }
      await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
      expect(await pre.evaluate(p => p.scrollWidth <= p.clientWidth + 1)).toBe(true)
      expect(await pre.textContent()).toBe(CODE)
      if (phone) {
        await setInsets(top, bottom)
        await page.setViewportSize(portrait)
        await expect(wrap).toHaveAttribute('aria-pressed', 'true')
        expect(await pre.textContent()).toBe(CODE)
      }
      if (browserName === 'chromium') {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
        const previousClipboard = `Code viewer clipboard fixture: ${mode}`
        await page.evaluate(text => navigator.clipboard.writeText(text), previousClipboard)
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(previousClipboard)
        await copy.click()
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 }).toBe(CODE)
      }
      await close.click()
      await expect(modal).toHaveCount(0)
      await expect(page.locator('[data-message-id="fullscreen-code"] pre').first()).toHaveCSS('white-space', phone ? 'pre' : 'pre-wrap')
      await expand.click()
      expect(await pre.textContent()).toBe(CODE)
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
    })
  })
}
