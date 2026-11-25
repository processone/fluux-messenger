import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

// Owns the phone full-screen layout and desktop compatibility from the reported iOS overlap.
// This is the four-line Erlang message from the original reproduction.
const CODE = [
  'replace_keywords(Host, {Element1, Element2}, Keywords) when is_list(Element1) ->',
  '    {replace_keywords(Host, Element1, Keywords), Element2};',
  'replace_keywords(Host, {Element1, Element2}, Keywords) when is_list(Element2) ->',
  '    {Element1, replace_keywords(Host, Element2, Keywords)}.',
].join('\n')

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
  return { modal, expand }
}

for (const phone of [true, false]) {
  test.describe(phone ? 'phone' : 'desktop', () => {
    test.use({ hasTouch: phone, isMobile: phone, deviceScaleFactor: phone ? 3 : 1 })
    test(`${phone ? 'phone' : 'desktop'} full-screen code opening and controls`, async ({ page, browserName }, testInfo) => {
      await page.setViewportSize(phone ? { width: 440, height: 956 } : { width: 1280, height: 800 })
      await page.emulateMedia({ reducedMotion: 'reduce' })
      // Chromium can expose nonzero CSS env insets; WebKitGTK cannot emulate UIKit's safe areas.
      const top = browserName === 'chromium' ? 62 : 0
      const bottom = browserName === 'chromium' ? 34 : 0
      if (browserName === 'chromium') {
        const cdp = await page.context().newCDPSession(page)
        await cdp.send('Emulation.setSafeAreaInsetsOverride', {
          insets: { top, topMax: top, bottom, bottomMax: bottom, left: 0, leftMax: 0, right: 0, rightMax: 0 },
        })
      }
      const { modal, expand } = await openCode(page)
      const pre = modal.locator('pre')
      const wrap = modal.locator('button[aria-pressed]')
      const geometry = await modal.evaluate(root => {
        const title = root.querySelector('h2')!
        const close = title.parentElement!.querySelector('button')!
        const pre = root.querySelector('pre')!
        const panel = root.querySelector('.fluux-glass')!
        const buttons = [...panel.lastElementChild!.querySelectorAll('button')]
        const box = panel.getBoundingClientRect()
        return {
          titleTop: title.getBoundingClientRect().top,
          closeTop: close.getBoundingClientRect().top,
          footerBottom: Math.max(...buttons.map(b => b.getBoundingClientRect().bottom)),
          width: pre.clientWidth, scrollWidth: pre.scrollWidth,
          panelTop: box.top, panelBottom: box.bottom, panelHeight: box.height,
          panelPaddingTop: getComputedStyle(panel).paddingTop, panelPaddingBottom: getComputedStyle(panel).paddingBottom,
        }
      })
      await testInfo.attach('opening-geometry', { body: JSON.stringify({ phone, browserName, top, bottom, ...geometry }, null, 2), contentType: 'application/json' })
      await testInfo.attach('opening', { body: await page.screenshot(), contentType: 'image/png' })
      if (phone) {
        expect.soft(geometry.titleTop).toBeGreaterThanOrEqual(top)
        expect.soft(geometry.closeTop).toBeGreaterThanOrEqual(top)
        expect.soft(geometry.footerBottom).toBeLessThanOrEqual(956 - bottom)
        expect.soft(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1)
        await expect.soft(wrap).toHaveAttribute('aria-pressed', 'true')
      } else {
        expect(geometry.panelPaddingTop).toBe('0px')
        expect(geometry.panelPaddingBottom).toBe('0px')
        expect(geometry.panelTop).toBeGreaterThan(0)
        expect(geometry.panelBottom).toBeLessThan(800)
        await expect(pre).toHaveCSS('white-space', 'pre')
        await expect(wrap).toHaveAttribute('aria-pressed', 'false')
        await wrap.click()
      }
      await expect(pre).toHaveText(CODE)
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
      await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'false')
      await expect(pre).toHaveCSS('white-space', 'pre')
      if (phone) expect(await pre.evaluate(p => p.scrollWidth > p.clientWidth)).toBe(true)
      await wrap.click()
      await expect(wrap).toHaveAttribute('aria-pressed', 'true')
      expect(await pre.evaluate(p => p.scrollWidth <= p.clientWidth + 1)).toBe(true)
      await expect(pre).toHaveText(CODE)
      const copy = modal.getByTitle('Copy code', { exact: true })
      await expect(copy).toBeVisible()
      if (browserName === 'chromium') {
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
        await copy.click()
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(CODE)
      }
      await modal.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(modal).toHaveCount(0)
      await expect(page.locator('[data-message-id="fullscreen-code"] pre').first()).toHaveCSS('white-space', phone ? 'pre' : 'pre-wrap')
      await expand.click()
      await expect(modal.locator('pre')).toHaveText(CODE)
      await expect(modal.locator('button[aria-pressed]')).toHaveAttribute('aria-pressed', 'true')
    })
  })
}
