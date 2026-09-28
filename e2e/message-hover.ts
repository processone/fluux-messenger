import { test, expect, type Page, type Locator } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'

async function seedRow(page: Page, content: 'long' | 'file', mode: 'light' | 'dark' = 'dark') {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(({ content, mode }) => {
    const demo = window as unknown as {
      __demoClient: DemoClient
      __settingsStore: typeof useSettingsStore
    }
    demo.__demoClient.stopAnimation()
    demo.__settingsStore.getState().setThemeMode(mode)
    demo.__settingsStore.getState().setMediaAutoDownload('always')
    const jid = 'emma@fluux.chat'
    const message = {
      id: 'hover-regression', stanzaId: undefined, originId: undefined,
      from: jid,
      body: content === 'long' ? 'Reading a long message\n'.repeat(50) : 'Reading a text file',
      timestamp: new Date(), isOutgoing: false,
      ...(content === 'file' ? { attachment: {
        url: URL.createObjectURL(new Blob(['Preview line\n'.repeat(40)], { type: 'text/plain' })),
        name: 'preview.txt', mediaType: 'text/plain', size: 520,
      } } : {}),
    }
    demo.__demoClient.emitSDK('chat:message', {
      message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true,
    })
    location.hash = `#/messages/${encodeURIComponent(jid)}`
  }, { content, mode })
  const row = page.locator('[data-message-id="hover-regression"][data-message-body]')
  const fade = row.locator('.pointer-events-none[style*="linear-gradient"]')
  await expect(fade).toHaveCount(1)
  await fade.scrollIntoViewIfNeeded()
  return { row, fade }
}

async function color(row: Locator, token: string) {
  return row.evaluate((element, token) => {
    const probe = document.createElement('span')
    probe.style.color = `var(${token})`
    element.append(probe)
    const value = getComputedStyle(probe).color
    probe.remove()
    return value
  }, token)
}

for (const content of ['long', 'file'] as const) {
  for (const mode of ['dark', 'light'] as const) {
    test(`chat ${content} ${mode}: pointer fill and fade survive toolbar suppression`, async ({ page }) => {
      const { row, fade } = await seedRow(page, content, mode)
      const toolbar = row.locator('[data-message-toolbar]')
      const hoverColor = await color(row, '--fluux-message-hover')
      const baseColor = await color(row, content === 'long' ? '--fluux-chat' : '--fluux-bg')
      await page.mouse.move(0, 0)
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(fade).toHaveCSS('background-image', new RegExp(baseColor.replace(/[()]/g, '\\$&')))

      // Freeze the intent timer: CSS feedback must already be painted before it fires.
      const clockStart = Date.now()
      await page.clock.install({ time: clockStart })
      await page.clock.pauseAt(clockStart + 10_000)
      await fade.hover({ force: true })
      await expect(toolbar).toHaveClass(/opacity-0/)
      await expect(row).toHaveCSS('background-color', hoverColor)
      await expect(fade).toHaveCSS('background-image', new RegExp(hoverColor.replace(/[()]/g, '\\$&')))
      await page.clock.runFor(250)
      await expect(toolbar).toHaveClass(/opacity-100/)

      await page.mouse.down()
      await expect(toolbar).toHaveClass(/opacity-0/)
      await expect(row).toHaveCSS('background-color', hoverColor)
      await row.locator('[data-msg-chrome]').evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        document.getSelection()!.removeAllRanges()
        document.getSelection()!.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
      })
      await page.mouse.up()
      await page.clock.runFor(300)
      await expect(toolbar).toHaveClass(/opacity-0/)
      await expect(row).toHaveCSS('background-color', hoverColor)
      await expect(fade).toHaveCSS('background-image', new RegExp(hoverColor.replace(/[()]/g, '\\$&')))

      await page.mouse.move(0, 0)
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(fade).toHaveCSS('background-image', new RegExp(baseColor.replace(/[()]/g, '\\$&')))
      await page.clock.resume()
      await fade.hover({ force: true })
      await page.evaluate(() => {
        document.getSelection()!.removeAllRanges()
        document.querySelector('[data-message-list]')!.closest<HTMLElement>('[tabindex="0"]')!.focus()
      })
      await page.keyboard.press('ArrowUp')
      await expect(row.locator('[data-msg-chrome]')).toHaveAttribute('data-msg-selected')
      await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const selectedColor = await color(row, '--fluux-selection')
      await expect(fade).toHaveCSS('background-image', new RegExp(selectedColor.replace(/[()]/g, '\\$&')))
      await page.screenshot({ path: test.info().outputPath('keyboard-selection.png') })
    })
  }
}

test(`chat: a touch tap cannot latch row hover`, async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, hasTouch: true, viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    const { row, fade } = await seedRow(page, 'file')
    expect(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches)).toBe(false)
    const baseColor = await color(row, '--fluux-bg')
    await row.locator('pre').tap()
    await expect(row).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(fade).toHaveCSS('background-image', new RegExp(baseColor.replace(/[()]/g, '\\$&')))
    await expect(row.locator('[data-message-toolbar]')).toBeHidden()
    await page.screenshot({ path: test.info().outputPath('touch-tap.png') })
  } finally {
    await context.close()
  }
})
