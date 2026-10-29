import { test, expect, type Page, type Locator } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'
import { AT_BOTTOM_OK_PX, waitForTopVisibleSettled, wheelAwayFromBottom } from './harness/scrollHarness'
import { arrive, distance, keepJson, measureDuring, mountedMessageIndexes, readInteractionReadState, readInteractionView, scrollToBottomContainer, interactionScrollFrames, findAndRevealInteractionText, setupInteraction, stableFrames, TARGET, waitForActions } from './harness/messageInteraction'

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

// Intent: FLM-229 requires deliberate input; moving content is not pointer intent.
for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: interaction hold ignores rows sliding under a resting pointer`, async ({ page }) => {
    const { list } = await setupInteraction(page, kind, true)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    for (let i = 0; i < 4; i++) {
      await arrive(page, kind, [`resting-${i}`])
      await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
      await expect(list).not.toHaveAttribute('data-message-interaction')
    }
    await keepJson(`${kind}-resting-pointer`, { heldMessage: await list.getAttribute('data-message-interaction'), distance: await distance(page) })
    await page.screenshot({ path: test.info().outputPath(`${kind}-resting-pointer.png`) })
  })

  test(`${kind}: interaction hold starts before toolbar delay and fixes row, controls and More during arrivals`, async ({ page }) => {
    const { row, body, list } = await setupInteraction(page, kind)
    await expect.poll(async () => (await readInteractionReadState(page, kind)).readId).not.toBeNull()
    const initialReadState = await readInteractionReadState(page, kind)
    const box = await body.boundingBox()
    await page.mouse.move(box!.x + 150, box!.y + 15, { steps: 3 })
    await expect(list).toHaveAttribute('data-message-interaction', await row.getAttribute('data-message-row-id') as string)
    // An arrival before the visibility delay must already be held.
    const top = (await body.boundingBox())!.y
    await arrive(page, kind, ['before-toolbar'])
    await expect.poll(async () => (await body.boundingBox())!.y).toBeCloseTo(top, 0)
    await expect(row.locator('[data-message-toolbar]')).toHaveClass(/opacity-100/)
    await stableFrames(page, TARGET)
    await row.getByRole('button', { name: 'More options', exact: true }).click()
    await row.getByRole('button', { name: 'Delete message', exact: true }).waitFor()
    await stableFrames(page, TARGET)
    const samples = await measureDuring(page, TARGET, async () => {
      for (let i = 0; i < 12; i++) {
        await arrive(page, kind, [`held-arrival-${i}`])
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
      }
    })
    await keepJson(`${kind}-held-geometry`, samples)
    // Captain FLM-245 F6: the jump must not cover a message's open menu.
    await expect(page.locator('[data-fab="scroll-to-bottom"]')).toHaveAttribute('tabindex', '-1')
    await expect(scrollToBottomContainer(page)).toBeHidden()
    const readState = await readInteractionReadState(page, kind)
    expect(readState.readId, 'the fixture establishes a real canonical pointer').not.toBeNull()
    expect(readState.unread, 'offscreen arrivals remain unread while delivery continues').toBeGreaterThan(0)
    expect(readState.readId).not.toBe(readState.lastId)
    await expect(page.locator('[data-fab="scroll-to-bottom"] span')).toHaveText(String(readState.unread))
    await keepJson(`${kind}-held-read-state`, { ...readState, initialReadId: initialReadState.readId })
    await page.keyboard.press('Escape')
    await expect(row.locator('[data-message-panel]')).toHaveCount(0)
    await expect(page.locator('[data-fab="scroll-to-bottom"]')).toHaveAttribute('tabindex', '0')
    await row.getByRole('button', { name: 'More options', exact: true }).click()
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    await expect(page.locator('[data-fab="scroll-to-bottom"]')).toHaveAttribute('tabindex', '-1')
    if (kind === 'room') {
      const capabilitySamples = await measureDuring(page, TARGET, () => page.evaluate(() => {
        const scope = window as any
        scope.__roomStore.getState().updateRoom('team@conference.fluux.chat', { isIrcGateway: true })
      }))
      await expect(row.getByRole('button', { name: 'Delete message', exact: true })).toBeDisabled()
      await keepJson('room-revoked-capability', { deletionDisabled: true, frames: capabilitySamples })
      await page.evaluate(() => (window as any).__roomStore.getState().updateRoom('team@conference.fluux.chat', { isIrcGateway: false }))
      await expect(row.getByRole('button', { name: 'Delete message', exact: true })).toBeEnabled()
    }
    // Pointer departure into the panel does not release; selecting Delete opens the original action.
    await row.getByRole('button', { name: 'Delete message', exact: true }).hover()
    await expect(list).toHaveAttribute('data-message-interaction')
    await row.getByRole('button', { name: 'Delete message', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Delete message', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.mouse.move(0, 0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await page.screenshot({ path: test.info().outputPath(`${kind}-released.png`) })
  })
}

for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: interaction hold keeps picker geometry through typing, preview and media growth, then restores keyboard focus`, async ({ page }) => {
    const { row, body, list } = await setupInteraction(page, kind)
    await body.hover()
    await waitForActions(page)
    await row.getByRole('button', { name: 'More reactions', exact: true }).click()
    await row.locator('em-emoji-picker').waitFor()
    await stableFrames(page, TARGET)
    // FLM-229: keeping the row fixed must not hide the picker's category/search controls.
    const pickerBox = (await row.locator('em-emoji-picker').boundingBox())!
    const listBox = (await list.boundingBox())!
    expect(pickerBox.y).toBeGreaterThanOrEqual(listBox.y)
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(listBox.y + listBox.height)
    await keepJson(`${kind}-picker-viewport-bounds`, { picker: pickerBox, list: listBox })
    let releaseMedia!: () => void
    const mediaReady = new Promise<void>(resolve => { releaseMedia = resolve })
    const mediaRequested = page.waitForRequest(request => request.url().includes('screenshot-chat-dark.png?interaction-media'))
    const mountedBefore = await mountedMessageIndexes(page)
    await page.route('**/demo/screenshot-chat-dark.png?interaction-media', async route => { await mediaReady; await route.continue() })
    const samples = await measureDuring(page, TARGET, async () => {
      await page.evaluate(async kind => {
        const scope = window as any
        const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
        scope.__demoClient.emitSDK(kind === 'chat' ? 'chat:typing' : 'room:typing', kind === 'chat'
          ? { conversationId: jid, jid, isTyping: true } : { roomJid: jid, nick: 'Adrien', isTyping: true })
        const state = kind === 'chat' ? scope.__chatStore.getState() : scope.__roomStore.getState()
        await state.updateMessage(jid, 'interaction-seed-44', {
          linkPreview: { url: 'https://example.invalid/meeting', title: 'Notes from the team conversation', siteName: 'Team notes' },
          reactions: { '👍': [kind === 'chat' ? jid : 'Adrien'] },
          attachment: { url: './demo/screenshot-chat-dark.png?interaction-media', name: 'conversation.png', mediaType: 'image/png', size: 50000 },
        })
      }, kind)
      await expect(page.locator('[data-typing-pill]')).toBeVisible()
      await mediaRequested
      await stableFrames(page, TARGET)
      releaseMedia()
      await expect.poll(() => page.getByAltText('conversation.png', { exact: true }).evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
      await page.evaluate(kind => {
        const scope = window as any
        const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
        scope.__demoClient.emitSDK(kind === 'chat' ? 'chat:typing' : 'room:typing', kind === 'chat'
          ? { conversationId: jid, jid, isTyping: false } : { roomJid: jid, nick: 'Adrien', isTyping: false })
      }, kind)
      await expect(page.locator('[data-typing-pill]')).toHaveCount(0)
      await arrive(page, kind, Array.from({ length: 40 }, (_, i) => `virtual-shift-${i}`))
    })
    const mountedAfter = await mountedMessageIndexes(page)
    await keepJson(`${kind}-picker-layout-geometry`, { samples, mountedBefore, mountedAfter })
    await page.screenshot({ path: test.info().outputPath(`${kind}-picker-held.png`) })
    const picker = row.locator('em-emoji-picker')
    await picker.getByRole('button', { name: /skin tone/i }).click()
    await expect(picker.getByRole('radiogroup')).not.toHaveClass(/hidden/)
    await page.keyboard.press('Escape')
    await expect(picker.getByRole('radiogroup')).toHaveCount(0)
    await expect(picker).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(row.locator('em-emoji-picker')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'More reactions', exact: true })).toBeFocused()
    await expect(list).toHaveAttribute('data-message-interaction')
    await row.getByRole('button', { name: 'React with 👍', exact: true }).click()
    await expect.poll(() => page.evaluate(kind => {
      const scope = window as any
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const state = kind === 'chat' ? scope.__chatStore.getState() : scope.__roomStore.getState()
      return state.messages.get(jid)?.find((message: any) => message.id === 'interaction-target')?.reactions?.['👍']?.length ?? 0
    }, kind)).toBeGreaterThan(0)
    await page.mouse.move(0, 0)
    await page.locator('textarea.message-input, .message-input[contenteditable="true"]').last().focus()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
  })

  test(`${kind}: interaction hold yields to manual navigation, sending and jumping; blur and removal close panels`, async ({ page }) => {
    const { row, list } = await setupInteraction(page, kind)
    const observations: unknown[] = []
    const record = async (stage: string) => {
      const observation = { stage, distance: await distance(page), held: await list.getAttribute('data-message-interaction'), panels: await list.locator('[data-message-panel]').count() }
      observations.push(observation)
      await keepJson(`${kind}-navigation-stage-${observations.length}`, observation)
    }
    let openIndex = 0
    const openPanel = async (id = TARGET, panel: 'more' | 'reactions' = 'more') => {
      const label = panel === 'more' ? 'More options' : 'More reactions'
      const target = page.locator(`.message-row[data-message-id="${id}"]`)
      await target.locator('[data-message-body]').hover()
      await waitForActions(page, id)
      await keepJson(`open-panel-${++openIndex}`, await target.evaluate((element, label) => {
        const toolbar = element.querySelector('[data-message-toolbar]')!
        const control = toolbar.querySelector(`[aria-label="${label}"]`)!
        const box = control.getBoundingClientRect()
        const style = getComputedStyle(toolbar)
        return { held: element.closest('[data-message-list]')?.getAttribute('data-message-interaction'),
          opacity: style.opacity, pointerEvents: getComputedStyle(control).pointerEvents,
          hit: document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)?.outerHTML,
          composing: !!element.closest('.composer-active'),
          shadow: (window as any).__fluuxScrollShadow?.() }
      }, label))
      await target.getByRole('button', { name: label, exact: true }).click()
      await expect(target.locator(`[data-message-panel="${panel}"]`)).toBeVisible()
      if (panel === 'reactions') await expect(target.locator('em-emoji-picker')).toBeVisible()
      return target
    }
    await openPanel()
    await arrive(page, kind, ['navigation-arrival'])
    await wheelAwayFromBottom(page, 200, -450)
    await expect(row.locator('[data-message-panel="more"]')).toHaveCount(0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect.poll(() => distance(page)).toBeGreaterThan(200)
    // A later arrival must not silently reacquire a hold or resume following.
    await arrive(page, kind, ['after-manual-navigation'])
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect.poll(() => distance(page)).toBeGreaterThan(200)
    await record('manual scroll remains away after another arrival')
    const historyId = await list.evaluate(element => {
      const viewport = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLElement>('.message-row')].find(row => {
        const box = row.getBoundingClientRect()
        return box.top > viewport.top + 40 && box.bottom < viewport.bottom - 40
      })!.dataset.messageId!
    })
    const historyBody = page.locator(`.message-row[data-message-id="${historyId}"] [data-message-body]`)
    await historyBody.hover()
    await expect(list).toHaveAttribute('data-message-interaction')
    const historyTop = (await historyBody.boundingBox())!.y
    await arrive(page, kind, ['history-hold-arrival'])
    await stableFrames(page, historyId)
    await page.mouse.move(0, 0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    const historyAfter = (await historyBody.boundingBox())!.y
    expect(Math.abs(historyAfter - historyTop)).toBeLessThanOrEqual(1)
    observations.push({ stage: 'history release', id: historyId, before: historyTop, after: historyAfter })
    const sendingRow = await openPanel(historyId, 'reactions')
    const input = page.locator('textarea.message-input, .message-input[contenteditable="true"]').last()
    await input.fill('My own send takes navigation priority.')
    await expect(sendingRow.locator('[data-message-panel="reactions"]')).toHaveCount(1)
    await input.press('Enter')
    await expect(page.getByText('My own send takes navigation priority.', { exact: true }).last()).toBeVisible()
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await expect(list.locator('[data-message-panel]')).toHaveCount(0)
    await record('own send closes the menu and reaches latest')
    await openPanel()
    // Safari mouse clicks do not focus buttons; give keyboard navigation an action target.
    await row.getByRole('button', { name: 'More options', exact: true }).focus()
    await page.keyboard.press('PageUp')
    await expect(row.locator('[data-message-panel="more"]')).toHaveCount(0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect.poll(() => distance(page)).toBeGreaterThan(1)
    expect(await waitForTopVisibleSettled(page)).not.toBeNull()
    await record('keyboard scroll closes the menu')
    await page.keyboard.press('End')
    expect(await waitForTopVisibleSettled(page)).not.toBeNull()
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    const latestOwnId = await page.getByText('My own send takes navigation priority.', { exact: true }).last()
      .locator('xpath=ancestor::*[@data-message-row-id][1]').getAttribute('data-message-id')
    await openPanel(latestOwnId!)
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await record('hold begins at latest before one small arrival')
    await arrive(page, kind, ['small-arrival'])
    await expect(page.locator('[data-fab="scroll-to-bottom"]')).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('Escape')
    await expect(list.locator('[data-message-panel]')).toHaveCount(0)
    await expect(page.locator('[data-fab="scroll-to-bottom"]')).toHaveAttribute('tabindex', '0')
    expect(await distance(page)).toBeLessThan(AT_BOTTOM_OK_PX)
    await record('small arrival exposes the existing jump control')
    await page.locator('[data-fab="scroll-to-bottom"]').click()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect(row.locator('[data-message-panel="more"]')).toHaveCount(0)
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await record('jump closes the menu and reaches latest')
    await openPanel()
    // Playwright forces every page focused. This checks the actual handler; native-engine
    // focus loss is verified separately with that automation override disabled.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect(row.locator('[data-message-panel="more"]')).toHaveCount(0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await keepJson(`${kind}-blur`, { trigger: 'scripted window blur event', held: await list.getAttribute('data-message-interaction') })
    await openPanel()
    await page.evaluate(async kind => {
      const scope = window as any
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const state = kind === 'chat' ? scope.__chatStore.getState() : scope.__roomStore.getState()
      await state.updateMessage(jid, 'interaction-target', { isRetracted: true, body: '' })
    }, kind)
    await expect(row.locator('[data-message-toolbar]')).toHaveCount(0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await record('target retraction closes actions')
    await page.evaluate(() => { location.hash = '#/messages/ava%40fluux.chat' })
    await expect(page.getByRole('heading', { name: 'Ava Martinez', exact: true })).toBeVisible()
    await expect(row).toHaveCount(0)
    await expect(page.locator('[data-message-list]')).not.toHaveAttribute('data-message-interaction')
    await record('conversation switch drops the original target')
    await keepJson(`${kind}-navigation-and-lifecycle`, observations)
  })
}

for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: interaction hold follows keyboard action focus and preserves native text selection`, async ({ page }) => {
    const { row, body, list } = await setupInteraction(page, kind)
    const more = row.getByRole('button', { name: 'More options', exact: true })
    await more.focus()
    await expect(list).toHaveAttribute('data-message-interaction')
    await page.keyboard.press('Enter')
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    await stableFrames(page, TARGET)
    const samples = await measureDuring(page, TARGET, () => arrive(page, kind, ['keyboard-arrival']))
    await keepJson(`${kind}-keyboard-geometry`, samples)
    await page.keyboard.press('Escape')
    await expect(more).toBeFocused()
    await expect(row.locator('[data-message-panel="more"]')).toHaveCount(0)
    const text = row.locator('[data-msg-text]').first()
    const box = (await text.boundingBox())!
    const top = (await body.boundingBox())!.y
    await page.mouse.move(box.x + 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + Math.min(box.width - 3, 210), box.y + box.height / 2, { steps: 8 })
    const selectedText = await page.evaluate(() => document.getSelection()?.toString() ?? '')
    expect(selectedText.length).toBeGreaterThan(0)
    await keepJson(`${kind}-native-selection`, { selectedText, heldMessage: await list.getAttribute('data-message-interaction') })
    await arrive(page, kind, ['selection-arrival'])
    await page.mouse.up()
    await stableFrames(page, TARGET)
    expect(Math.abs((await body.boundingBox())!.y - top)).toBeLessThanOrEqual(1)
    await expect(row.locator('[data-message-toolbar]')).toHaveClass(/opacity-0/)
    await page.mouse.move(0, 0)
    await page.locator('textarea.message-input, .message-input[contenteditable="true"]').last().focus()
    await expect(list).not.toHaveAttribute('data-message-interaction')
  })
}

// Captain FLM-245 F1/F2/F7: weak pointer intent must yield to composing and native drag completion.
for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: interaction hold releases pointer-only composing, mouse focus and completed native drags`, async ({ page }) => {
    const { row, body, list } = await setupInteraction(page, kind)
    const input = page.locator('textarea.message-input, .message-input[contenteditable="true"]').last()
    const observations: unknown[] = []
    await input.focus()
    await body.hover()
    await expect(list).toHaveAttribute('data-message-interaction')
    await input.pressSequentially('A reply in progress')
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await arrive(page, kind, ['composer-after-nudge'])
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    observations.push({ stage: 'typing releases pointer-only intent', ...await readInteractionView(page) })
    await body.hover()
    await waitForActions(page)
    const more = row.getByRole('button', { name: 'More options', exact: true })
    await more.click()
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    // Typing does not dismiss an explicit open action panel.
    await input.pressSequentially(' with a menu open')
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    await expect(list).toHaveAttribute('data-message-interaction')
    await more.click()
    await page.mouse.move(0, 0)
    await expect(row.locator('[data-message-toolbar]')).toHaveCSS('opacity', '0')
    await expect(list).not.toHaveAttribute('data-message-interaction')
    observations.push({ stage: 'mouse focus does not retain toolbar visibility', ...await readInteractionView(page) })
    await page.route('https://example.invalid/**', route => route.abort())
    await page.evaluate(async kind => {
      const scope = window as any
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const store = kind === 'chat' ? scope.__chatStore : scope.__roomStore
      await store.getState().updateMessage(jid, 'interaction-target', { body: 'Drag this link: https://example.invalid/review' })
      scope.__reviewDragEvents = []
      for (const type of ['mousedown', 'mouseup', 'dragstart', 'dragend', 'drop']) {
        document.addEventListener(type, event => scope.__reviewDragEvents.push({ type, trusted: event.isTrusted }), true)
      }
      const drop = document.createElement('div')
      drop.dataset.reviewDrop = 'true'
      drop.textContent = 'Local drop target'
      drop.style.cssText = 'position:fixed;left:330px;bottom:12px;width:230px;height:34px;z-index:200'
      drop.addEventListener('dragover', event => event.preventDefault())
      drop.addEventListener('drop', event => event.preventDefault())
      document.body.append(drop)
    }, kind)
    await row.locator('a[href="https://example.invalid/review"]').dragTo(page.locator('[data-review-drop]'))
    await page.mouse.move(0, 0)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    const events = await page.evaluate(() => (window as any).__reviewDragEvents as { type: string; trusted: boolean }[])
    expect(events.some(event => event.type === 'dragstart' && event.trusted)).toBe(true)
    expect(events.some(event => event.type === 'dragend' && event.trusted)).toBe(true)
    expect(events.some(event => event.type === 'drop' && event.trusted)).toBe(true)
    observations.push({ stage: 'native drag terminates without a stuck hold', events, ...await readInteractionView(page) })
    const nextId = await list.evaluate(element => {
      const view = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLElement>('.message-row')].find(row => {
        const box = row.getBoundingClientRect()
        return row.dataset.messageId !== 'interaction-target' && box.top > view.top + 40 && box.bottom < view.bottom - 40
      })!.dataset.messageId!
    })
    await page.locator(`.message-row[data-message-id="${nextId}"] [data-message-body]`).hover()
    await expect(list).toHaveAttribute('data-message-interaction')
    observations.push({ stage: 'another row can acquire after the drag', id: nextId, ...await readInteractionView(page, nextId) })
    await keepJson(`${kind}-review-pointer-cleanup`, observations)
  })

  // Captain FLM-245 F3: real unobserved browser scrolling must win before another reconcile.
  test(`${kind}: interaction hold yields to native selection-edge autoscroll and browser find`, async ({ page }) => {
    const { row, body, list } = await setupInteraction(page, kind)
    const observations: unknown[] = []
    await body.hover()
    await expect(list).toHaveAttribute('data-message-interaction')
    await arrive(page, kind, Array.from({ length: 12 }, (_, i) => `edge-selection-${i}`))
    const before = await readInteractionView(page)
    const text = row.locator('[data-msg-text]').first()
    const box = (await text.boundingBox())!, view = (await list.boundingBox())!
    await page.mouse.move(box.x + 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + Math.min(180, box.width - 3), box.y + box.height / 2, { steps: 5 })
    await page.mouse.move(box.x + 80, view.y + view.height + 15, { steps: 12 })
    const selectionFrames = await interactionScrollFrames(page)
    await keepJson(`${kind}-native-selection-scroll-frames`, { before, samples: selectionFrames, after: await readInteractionView(page) })
    await expect.poll(async () => (await readInteractionView(page)).top).toBeGreaterThan(before.top + 1)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    expect((await readInteractionView(page)).selectedText.length).toBeGreaterThan(0)
    await page.mouse.up()
    observations.push({ stage: 'native selection autoscroll takes over', before, after: await readInteractionView(page) })
    const findId = await list.evaluate(element => {
      const view = element.getBoundingClientRect()
      return [...element.querySelectorAll<HTMLElement>('.message-row')].find(row => row.getBoundingClientRect().bottom < view.top - 5)!.dataset.messageId!
    })
    const query = 'An earlier conversation message to find'
    await page.evaluate(async ({ kind, id, query }) => {
      const scope = window as any
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const store = kind === 'chat' ? scope.__chatStore : scope.__roomStore
      await store.getState().updateMessage(jid, id, { body: query })
      document.getSelection()?.removeAllRanges()
    }, { kind, id: findId, query })
    await expect(page.locator(`.message-row[data-message-id="${findId}"]`)).not.toBeInViewport()
    await body.hover()
    await waitForActions(page)
    await row.getByRole('button', { name: 'More options', exact: true }).click()
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    const findBefore = await readInteractionView(page)
    const findTargetBefore = await page.locator(`.message-row[data-message-id="${findId}"]`).boundingBox()
    const findResult = await findAndRevealInteractionText(page, query)
    const found = findResult.found
    expect(found).toBe(true)
    const findFrames = await interactionScrollFrames(page)
    await keepJson(`${kind}-native-find-scroll-frames`, { findResult, id: findId, targetBefore: findTargetBefore, before: findBefore, samples: findFrames, after: await readInteractionView(page), targetAfter: await page.locator(`.message-row[data-message-id="${findId}"]`).boundingBox() })
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await expect(row.locator('[data-message-panel]')).toHaveCount(0)
    await expect(page.locator(`.message-row[data-message-id="${findId}"]`)).toBeInViewport()
    expect(await waitForTopVisibleSettled(page)).not.toBeNull()
    observations.push({ stage: 'native find scroll takes over without snapback', found, id: findId, before: findBefore, after: await readInteractionView(page) })
    await keepJson(`${kind}-review-native-scroll`, observations)
  })
}
