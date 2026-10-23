import { test, expect, type Locator, type Page } from '@playwright/test'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import {
  loadDemo, navigateToStressRoom, activateChat, scrollToBottom, settle, assertScrollShadow,
  wheelAwayFromBottom, CLEAR_OF_BOTTOM_PX,
} from './harness/scrollHarness'

const ROOM = 'stress-0@conference.fluux.chat'
const CHAT = 'ava@fluux.chat'

test.afterEach(assertScrollShadow)

async function fixture(page: Page, kind: 'chat' | 'room', virtualized: boolean) {
  await page.setViewportSize({ width: 1920, height: 900 })
  await loadDemo(page)
  if (kind === 'chat') await activateChat(page, 'james@fluux.chat')
  await page.evaluate(({ kind, virtualized, room, chat }) => {
    const scope = window as unknown as {
      __demoClient: { stopAnimation(): void; emitSDK(event: string, payload: unknown): void }
      __settingsStore: typeof useSettingsStore
      __chatStore: typeof chatStore
      __roomStore: typeof roomStore
    }
    scope.__demoClient.stopAnimation()
    localStorage.setItem('fluux:flags:enableMessageVirtualization', String(virtualized))
    const body = 'A comfortable reading column keeps a long conversation easy to follow. '.repeat(5)
    for (let i = 0; i < 80; i++) {
      const common = { id: `reading-width-${i}`, body, timestamp: new Date(Date.now() + i), isOutgoing: false }
      if (kind === 'room') {
        scope.__demoClient.emitSDK('room:message', {
          roomJid: room,
          message: { ...common, type: 'groupchat', roomJid: room, from: `${room}/Reader${i % 3}`, nick: `Reader${i % 3}` },
          incrementUnread: false,
        })
      } else {
        scope.__demoClient.emitSDK('chat:message', {
          message: { ...common, type: 'chat', conversationId: chat, from: chat }, isLiveArrival: false,
        })
      }
    }
    if (kind === 'room') scope.__roomStore.getState().advanceReadPointer(room, { id: 'reading-width-79' })
    else scope.__chatStore.getState().advanceReadPointer(chat, { id: 'reading-width-79' })
  }, { kind, virtualized, room: ROOM, chat: CHAT })
  if (kind === 'room') await navigateToStressRoom(page, virtualized)
  else await activateChat(page, CHAT)
  await scrollToBottom(page)
  await expect(page.locator('.message-row[data-message-id="reading-width-79"]')).toBeAttached()
  return page.locator('[data-message-list]')
}

async function width(page: Page, value: number | false) {
  await page.evaluate(value => {
    const settings = (window as unknown as { __settingsStore: typeof useSettingsStore }).__settingsStore.getState()
    if (value === false) settings.setReadingWidthEnabled(false)
    else { settings.setReadingWidthEnabled(true); settings.setReadingWidth(value) }
  }, value)
  await settle(page)
}

/** The row crossing the list's bottom edge, and how far down that row the edge falls. */
async function bottomAnchor(list: Locator) {
  return list.evaluate(element => {
    const bottom = element.getBoundingClientRect().bottom
    const row = Array.from(element.querySelectorAll<HTMLElement>('.message-row')).find(row => {
      const rect = row.getBoundingClientRect()
      return rect.top < bottom && rect.bottom >= bottom
    })!
    const rect = row.getBoundingClientRect()
    return { id: row.dataset.messageId!, fraction: (bottom - rect.top) / rect.height }
  })
}

async function expectBottomAnchorHeld(list: Locator, anchor: { id: string; fraction: number }) {
  const row = list.locator(`.message-row[data-message-id="${anchor.id}"]`)
  await expect(row).toBeAttached()
  const rowBox = (await row.boundingBox())!
  const listBox = (await list.boundingBox())!
  expect(Math.abs(rowBox.y + rowBox.height * anchor.fraction - listBox.y - listBox.height)).toBeLessThanOrEqual(4)
}

async function wrappedDraft(page: Page) {
  // Typed line by line: the room composer is a contenteditable, where a newline
  // in a single fill is not a line break.
  const composer = page.locator('.message-input').first()
  await composer.click()
  await page.keyboard.insertText('A multiline draft should grow when the reading column narrows. '.repeat(5))
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.insertText('The next paragraph stays unsent while reading history.')
  await settle(page)
}

for (const kind of ['chat', 'room'] as const) {
  for (const virtualized of [false, true]) {
    test(`${kind} reading width rewraps and holds the live edge (virtualized: ${virtualized})`, async ({ page }, testInfo) => {
      const list = await fixture(page, kind, virtualized)
      await wrappedDraft(page)
      const column = page.locator('[data-conversation-column]')
      await expect(column).toHaveCSS('max-width', 'none')
      expect((await column.boundingBox())!.width).toBeGreaterThan(1120)
      await width(page, 760)
      await expect(column).toHaveCSS('max-width', '760px')
      expect((await column.boundingBox())!.width).toBe(760)
      const initial = await list.locator('.message-row[data-message-id="reading-width-79"]').boundingBox()
      for (const value of [560, 1120, 760, false, 760] as const) {
        await width(page, value)
        if (value === false) expect((await column.boundingBox())!.width).toBeGreaterThan(1120)
        else expect((await column.boundingBox())!.width).toBe(value)
        if (value === 560) {
          await expect(list.locator('.message-row[data-message-id="reading-width-79"]')).toBeAttached({ timeout: 10_000 })
          expect((await list.locator('.message-row[data-message-id="reading-width-79"]').boundingBox())!.height).toBeGreaterThan(initial!.height)
        }
        const samples = await list.evaluate(async element => {
          const samples: number[] = []
          for (let i = 0; i < 30; i++) {
            await new Promise(requestAnimationFrame)
            samples.push(element.scrollHeight - element.clientHeight - element.scrollTop)
          }
          return samples
        })
        expect(Math.max(...samples), 'live edge remains pinned after rewrap settles').toBeLessThanOrEqual(4)
        expect(Math.max(...samples) - Math.min(...samples), 'scroll stops fighting once width settles').toBeLessThanOrEqual(1)
      }
      const columnBox = (await column.boundingBox())!
      const parentBox = await column.evaluate(element => {
        const rect = element.parentElement!.getBoundingClientRect()
        return { x: rect.x, width: rect.width }
      })
      expect(Math.abs(columnBox.x - parentBox.x - (parentBox.width - columnBox.width) / 2)).toBeLessThanOrEqual(1)
      await page.screenshot({ path: testInfo.outputPath(`${kind}-reading-width.png`) })
    })
  }

  for (const virtualized of [false, true]) {
    test(`${kind} reading width preserves wheel-scrolled history (virtualized: ${virtualized})`, async ({ page }) => {
      const list = await fixture(page, kind, virtualized)
      await width(page, 1120)
      await wrappedDraft(page)
      const wideHeight = (await list.boundingBox())!.height
      await wheelAwayFromBottom(page, CLEAR_OF_BOTTOM_PX, -1200)
      await settle(page)
      expect(await list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(500)
      for (const value of [560, 1120, 560]) {
        const anchor = await bottomAnchor(list)
        await width(page, value)
        if (value === 560) expect((await list.boundingBox())!.height).toBeLessThan(wideHeight)
        expect(await list.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(500)
        await expectBottomAnchorHeld(list, anchor)
        const before = await list.evaluate(element => element.scrollTop)
        await settle(page)
        expect(Math.abs(await list.evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(1)
        await list.hover()
        await page.mouse.wheel(0, -400)
        await settle(page)
      }
    })
  }

  // A row that resizes inside the viewport can move the rows below it without a scroll event (the
  // virtualized list does not compensate a resize below its scroll offset): the reading point a
  // width change preserves must be the one on screen, not the one the last scroll left.
  for (const virtualized of [false, true]) {
    test(`${kind} reading width preserves history after a visible row resizes (virtualized: ${virtualized})`, async ({ page }) => {
      const list = await fixture(page, kind, virtualized)
      await width(page, 1120)
      await wheelAwayFromBottom(page, CLEAR_OF_BOTTOM_PX, -1200)
      await settle(page)
      const id = await list.evaluate(element => {
        const box = element.getBoundingClientRect()
        const row = Array.from(element.querySelectorAll<HTMLElement>('.message-row')).find(row => {
          const rect = row.getBoundingClientRect()
          return rect.top > box.top + 100 && rect.bottom < box.top + box.height / 2
        })!
        return row.dataset.messageId!
      })
      await page.evaluate(({ kind, id, room, chat }) => {
        const client = (window as unknown as {
          __demoClient: { emitSDK(event: string, payload: unknown): void }
        }).__demoClient
        const updates = { body: 'A corrected message wraps onto several more lines of the reading column. '.repeat(12) }
        if (kind === 'room') client.emitSDK('room:message-updated', { roomJid: room, messageId: id, updates })
        else client.emitSDK('chat:message-updated', { conversationId: chat, messageId: id, updates })
      }, { kind, id, room: ROOM, chat: CHAT })
      await settle(page)
      const anchor = await bottomAnchor(list)
      await width(page, 560)
      await expectBottomAnchorHeld(list, anchor)
    })
  }

  test(`${kind} reading width keeps the selected history row visible`, async ({ page }) => {
    const list = await fixture(page, kind, true)
    await wrappedDraft(page)
    const id = 'reading-width-30'
    await page.evaluate(({ kind, id }) => {
      const scope = window as unknown as { __chatStore: typeof chatStore; __roomStore: typeof roomStore }
      if (kind === 'room') scope.__roomStore.getState().setTargetMessageId(id)
      else scope.__chatStore.getState().setTargetMessageId(id)
    }, { kind, id })
    await expect(page.locator('.message-highlight')).toBeVisible()
    await settle(page)
    for (const value of [560, 1120, 760]) {
      await width(page, value)
      const row = (await page.locator(`.message-row[data-message-id="${id}"]`).boundingBox())!
      const viewport = (await list.boundingBox())!
      expect(row.y).toBeGreaterThanOrEqual(viewport.y - 1)
      expect(row.y + row.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1)
      const before = await list.evaluate(element => element.scrollTop)
      await settle(page)
      expect(Math.abs(await list.evaluate(element => element.scrollTop) - before)).toBeLessThanOrEqual(1)
    }
  })
}

for (const kind of ['chat', 'room'] as const) {
  test(`${kind} reading width leaves mobile layout unchanged`, async ({ page }) => {
    const list = await fixture(page, kind, true)
    await page.setViewportSize({ width: 390, height: 844 })
    await settle(page)
    const before = await list.boundingBox()
    await width(page, 560)
    expect(await list.boundingBox()).toEqual(before)
    await width(page, false)
    expect(await list.boundingBox()).toEqual(before)
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
  })
}
