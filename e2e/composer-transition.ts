/**
 * Reported one-line composer growth must not clip the latest message while the
 * viewport is resizing. Real demo text and browser Range geometry own this fact;
 * settled geometry and jsdom cannot see the transient failure.
 */
import { test, expect } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

for (const view of ['room', 'chat'] as const) {
  for (const startLines of [1, 2]) {
    test(`${view}: natural ${startLines}-to-${startLines + 1} line wrap keeps latest text visible`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1298, height: 950 })
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        return ['127.0.0.1', 'localhost'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)
          ? route.continue() : route.abort()
      })
      await bootDemo(page, '/demo.html?tutorial=false&virt=1')
      await page.evaluate(() => {
        const client = (window as Window & {
          __demoClient: { stopAnimation(): void; messages: { sendChatState(): Promise<void> } }
        }).__demoClient
        client.stopAnimation()
        client.messages.sendChatState = async () => {}
      })
      if (view === 'room') {
        await page.locator('[data-nav="rooms"]').click()
        await page.getByText('Team Chat', { exact: true }).first().click()
      }
      const editor = page.locator(view === 'room'
        ? '.message-input[contenteditable="true"]' : 'textarea.message-input')
      await editor.waitFor({ state: 'visible' })
      const draft = await page.locator('[data-message-list] [data-message-body]').evaluateAll(elements =>
        elements.map(el => (el as HTMLElement).dataset.messageBody ?? '')
          .filter(text => text.length > 30 && !text.includes('\n')).join(' '))
      expect(draft, 'reuse rendered demo messages as realistic draft text').not.toBe('')
      await editor.focus()
      await page.keyboard.insertText(draft.slice(0, 12))
      if (startLines === 2) {
        await page.keyboard.press('Shift+Enter')
        await page.keyboard.insertText(draft.slice(0, 12))
      }
      await page.locator('[data-message-list]').evaluate(el => { el.scrollTop = el.scrollHeight })
      await expect.poll(() => page.locator('[data-message-list]').evaluate(el =>
        el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1)

      const baseline = await editor.evaluate(el => ({
        height: el.getBoundingClientRect().height,
        lineHeight: parseFloat(getComputedStyle(el).lineHeight),
      }))
      expect(baseline.height).toBe(startLines * baseline.lineHeight)
      await page.evaluate(() => {
        const scroller = document.querySelector<HTMLElement>('[data-message-list]')!
        const input = document.querySelector<HTMLElement>('.message-input')!
        const tail = [...scroller.querySelectorAll<HTMLElement>('.message-row[data-message-id]')].at(-1)!
        const body = tail.querySelector('[data-message-body]') ?? tail
        const samples: { height: number; clearance: number; top: number; viewport: number; time: number }[] = []
        const read = () => {
          const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
          let bottom = -Infinity
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!node.textContent?.trim()) continue
            const parent = node.parentElement!
            if (parent.closest('[data-message-toolbar]') || getComputedStyle(parent).visibility === 'hidden') continue
            const range = document.createRange()
            range.selectNodeContents(node)
            for (const rect of range.getClientRects()) {
              if (rect.width > 0 && rect.height > 0) bottom = Math.max(bottom, rect.bottom)
            }
          }
          return { height: input.getBoundingClientRect().height,
            clearance: scroller.getBoundingClientRect().bottom - bottom,
            top: scroller.scrollTop, viewport: scroller.clientHeight, time: performance.now() }
        }
        let frameId = 0
        const recordFrame = () => {
          samples.push(read())
          frameId = requestAnimationFrame(recordFrame)
        }
        // rAF runs BEFORE resize delivery. Replace that frame's preliminary read
        // with its post-reconciliation geometry, rather than mistaking a pre-paint
        // layout read for painted clipping. Installed after the app's observer,
        // this sees its result in the same rendering opportunity, not a later frame.
        const observer = new ResizeObserver(() => {
          samples[samples.length - 1] = read()
        })
        samples.push(read())
        observer.observe(scroller)
        frameId = requestAnimationFrame(recordFrame)
        ;(window as Window & { __composerTransition?: { samples: typeof samples; stop(): void } }).__composerTransition = {
          samples, stop: () => { observer.disconnect(); cancelAnimationFrame(frameId) },
        }
      })
      let wrapped = false
      for (const char of draft.slice(12)) {
        await page.keyboard.insertText(char)
        if (await editor.evaluate(el => el.getBoundingClientRect().height) > baseline.height) {
          wrapped = true
          break
        }
      }
      expect(wrapped, 'real keyboard input naturally wraps').toBe(true)
      await page.evaluate(() => new Promise<void>(resolve =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const samples = await page.evaluate(() => {
        const probe = (window as Window & { __composerTransition: {
          samples: { height: number; clearance: number; top: number; viewport: number; time: number }[]; stop(): void
        } }).__composerTransition
        probe.stop()
        return probe.samples
      })
      await testInfo.attach('transition-geometry', { body: JSON.stringify(samples, null, 2), contentType: 'application/json' })
      expect(samples.every(sample => Number.isFinite(sample.clearance)), 'measure actual latest-message text').toBe(true)
      expect(samples[0].clearance, 'start with fully visible latest-message text').toBeGreaterThanOrEqual(0)
      const grown = samples.filter(sample => sample.height > baseline.height)
      expect(grown.length, 'observe transition frames including resize delivery').toBeGreaterThan(0)
      expect(grown.every(sample => sample.height === baseline.height + baseline.lineHeight), 'exactly one line grew').toBe(true)
      expect(Math.min(...grown.map(sample => sample.clearance)), 'latest-message text stays inside the viewport in every frame').toBeGreaterThanOrEqual(-1)
    })
  }
}
