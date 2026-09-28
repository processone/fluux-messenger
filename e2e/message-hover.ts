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
      const selectedColor = await color(row, '--fluux-selection')
      await expect(row).toHaveCSS('background-color', selectedColor)
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

for (const kind of ['chat', 'room'] as const) {
  for (const { width, mode } of [1280, 800].flatMap(width =>
    (['light', 'dark'] as const).map(mode => ({ width, mode })))) {
    test(`${kind} ${width}px ${mode}: keyboard highlight preserves content geometry and quote styling`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 })
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(({ kind, mode }) => {
        const demo = window as unknown as {
          __demoClient: DemoClient
          __settingsStore: typeof useSettingsStore
        }
        demo.__demoClient.stopAnimation()
        demo.__settingsStore.getState().setThemeMode(mode)
        const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
        const message = {
          id: 'keyboard-geometry', stanzaId: undefined, originId: undefined,
          timestamp: new Date(), isOutgoing: false,
          replyTo: {
            id: 'geometry-original',
            to: kind === 'chat' ? jid : `${jid}/Adrien`,
            fallbackBody: 'Synthetic original message for reply framing.',
          },
          from: kind === 'chat' ? jid : `${jid}/Adrien`,
          body: [
            'We should keep the same message layout while reading with the keyboard. This paragraph is deliberately long enough to wrap across several lines in the conversation.',
            '> The first quoted paragraph describes the proposed behaviour and must retain its original width, spacing, and border when the message is selected.',
            'The reply continues here with additional context so that narrowing the available width changes the line breaks in a visible way.',
            '> A second quote gives another example with several words that should wrap consistently regardless of keyboard selection.',
            'The final paragraph closes the discussion and should remain aligned with the rest of the message.',
          ].join('\n\n'),
        }
        const original = {
          ...message, id: 'geometry-original', replyTo: undefined,
          body: 'Synthetic original message for reply framing.',
          timestamp: new Date(message.timestamp.getTime() - 1000),
        }
        if (kind === 'chat') {
          demo.__demoClient.emitSDK('chat:message', {
            message: { ...original, type: 'chat', conversationId: jid }, isLiveArrival: true,
          })
          demo.__demoClient.emitSDK('chat:message', {
            message: { ...message, type: 'chat', conversationId: jid }, isLiveArrival: true,
          })
        } else {
          demo.__demoClient.emitSDK('room:message', {
            roomJid: jid,
            message: { ...original, type: 'groupchat', roomJid: jid, nick: 'Adrien', occupantId: undefined },
            isLiveArrival: true, incrementUnread: true,
          })
          demo.__demoClient.emitSDK('room:message', {
            roomJid: jid,
            message: { ...message, type: 'groupchat', roomJid: jid, nick: 'Adrien', occupantId: undefined },
            isLiveArrival: true, incrementUnread: true,
          })
        }
        location.hash = `#/${kind === 'chat' ? 'messages' : 'rooms'}/${encodeURIComponent(jid)}`
      }, { kind, mode })
      const row = page.locator('[data-message-id="keyboard-geometry"][data-message-body]')
      const chrome = row.locator('[data-msg-chrome]')
      const reply = row.locator('.reply-quote-card')
      await expect(reply).toBeVisible()
      await expect(row.locator('.blockquote-decorated')).toHaveCount(2)
      await row.scrollIntoViewIfNeeded()
      await page.mouse.move(0, 0)
      const measure = () => chrome.evaluate(element => {
        const origin = element.closest('[data-message-body]')!.getBoundingClientRect()
        const box = (node: Element) => {
          const rect = node.getBoundingClientRect()
          const css = getComputedStyle(node)
          return {
            x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height,
            padding: css.padding, border: css.borderWidth,
          }
        }
        const body = element.querySelector('[data-msg-text]')!
        const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
        const lines = []
        while (walker.nextNode()) {
          const range = document.createRange()
          range.selectNodeContents(walker.currentNode)
          lines.push([...range.getClientRects()].map(rect => ({
            x: rect.x - origin.x, y: rect.y - origin.y, width: rect.width, height: rect.height,
          })))
        }
        return {
          chrome: box(element), body: box(body), lines,
          quotes: [...element.querySelectorAll('.blockquote-decorated, .reply-quote-card')].map(quote => ({
            ...box(quote), background: getComputedStyle(quote).background,
            shadow: getComputedStyle(quote).boxShadow,
          })),
        }
      })
      const baseline = await measure()
      await page.screenshot({ path: test.info().outputPath('unselected-geometry.png') })
      await row.hover()
      expect(await measure()).toEqual(baseline)
      await page.mouse.move(0, 0)
      await page.locator('[data-message-list]').evaluate(element => element.closest<HTMLElement>('[tabindex="0"]')!.focus())
      await page.keyboard.press('ArrowUp')
      await expect(chrome).toHaveAttribute('data-msg-selected')
      await expect(row).toHaveCSS('background-color', await color(row, '--fluux-selection'))
      expect(await measure()).toEqual(baseline)
      await page.screenshot({ path: test.info().outputPath('keyboard-geometry.png') })
      // Toolbar intent settles after the keyboard-to-pointer cooldown.
      await expect(row.locator('[data-message-toolbar]')).toHaveClass(/opacity-100/)
      await row.hover({ position: { x: 12, y: 24 } })
      await expect(chrome).not.toHaveAttribute('data-msg-selected')
      expect(await measure()).toEqual(baseline)
      await page.mouse.move(0, 0)
      const sender = reply.locator('span.font-medium')
      const senderColor = await sender.evaluate(element => getComputedStyle(element).color)
      const brandColor = await color(row, '--fluux-brand')
      const overlayColor = await color(row, '--fluux-quote-selected-overlay')
      expect(senderColor).not.toBe(brandColor)
      await expect(reply).toHaveCSS('border-left-color', senderColor)
      await page.locator('[data-message-list]').evaluate(element => element.closest<HTMLElement>('[tabindex="0"]')!.focus())
      await page.keyboard.press('ControlOrMeta+a')
      const copyRow = page.locator('.message-row').filter({ has: row })
      await expect(copyRow).toHaveAttribute('data-msg-selected')
      for (const card of await row.locator('.blockquote-decorated, .reply-quote-card').all()) {
        const frameColor = await card.evaluate(element => getComputedStyle(element).borderLeftColor)
        await expect(card).toHaveCSS('box-shadow', `${frameColor} 0px 0px 0px 1px inset`)
        await expect(card).toHaveCSS('background-image', `linear-gradient(${overlayColor}, ${overlayColor})`)
      }
      await expect(sender).toHaveCSS('color', senderColor)
      await expect(reply).toHaveCSS('border-left-color', senderColor)
      await page.screenshot({ path: test.info().outputPath('bulk-copy-framing.png') })
      await page.keyboard.press('Escape')
      await expect(copyRow).not.toHaveAttribute('data-msg-selected')
      expect(await measure()).toEqual(baseline)
    })
  }
}
