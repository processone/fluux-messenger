import { test, expect, type Page } from '@playwright/test'
import {
  AT_BOTTOM_OK_PX,
  loadDemo,
  assertScrollShadow,
  scrollToBottom,
  wheelAwayFromBottom,
  settle,
} from './harness/scrollHarness'

// Source: FLM-399 / review FLM-404 R5 — "Wrap lines" on message code blocks, exercised in the
// real (virtualized) message list of the isolated demo: no account, no network.

test.afterEach(assertScrollShadow)

const ROOM = 'wrap-code@conference.fluux.chat'
const OTHER_ROOM = 'wrap-other@conference.fluux.chat'
const LONG_LINE = 'I am Adrien from ProcessOne, following up on a long email whose lines never end: ' + 'lorem ipsum dolor sit amet '.repeat(10)
const CODE_BODY = 'Draft:\n```\n' + Array.from({ length: 6 }, (_, i) => `${i + 1}. ${LONG_LINE}`).join('\n') + '\n```'

async function seedRoom(page: Page, jid: string, codeEvery: number): Promise<void> {
  await page.evaluate(({ jid, codeEvery, codeBody }) => {
    const scope = window as unknown as {
      __roomStore: { getState: () => { rooms: Map<string, object> } }
      __demoClient: { emitSDK: (event: string, payload: unknown) => void }
    }
    const base = scope.__roomStore.getState().rooms.get('stress-0@conference.fluux.chat')
    if (!base) throw new Error('stress room not seeded')
    scope.__demoClient.emitSDK('room:added', { room: { ...base, jid, name: jid, unreadCount: 0, mentionsCount: 0 } })
    for (let i = 0; i < 60; i++) {
      const nick = `Fixture${i % 5}`
      scope.__demoClient.emitSDK('room:message', {
        roomJid: jid,
        message: {
          type: 'groupchat', id: `${jid}-${i}`, stanzaId: `sid-${jid}-${i}`, roomJid: jid,
          from: `${jid}/${nick}`, nick,
          body: i % codeEvery === codeEvery - 1 ? codeBody : `Plain fixture message ${i}`,
          timestamp: new Date(Date.UTC(2026, 0, 1, 12, i)), isOutgoing: false,
        },
        incrementUnread: false,
      })
    }
  }, { jid, codeEvery, codeBody: CODE_BODY })
  await page.waitForFunction((j) => {
    const s = window as unknown as { __roomStore: { getState: () => { messages: Map<string, unknown[]> } } }
    return s.__roomStore.getState().messages.get(j)?.length === 60
  }, jid)
}

async function openRoom(page: Page, jid: string): Promise<void> {
  await page.evaluate((j) => {
    const s = window as unknown as { __roomStore: { getState: () => { activateRoom: (j: string) => Promise<void> } } }
    void s.__roomStore.getState().activateRoom(j)
    window.location.hash = '#/rooms/' + encodeURIComponent(j)
  }, jid)
  await page.waitForFunction((j) => {
    const s = window as unknown as { __roomStore: { getState: () => { activeRoomJid: string | null } } }
    return s.__roomStore.getState().activeRoomJid === j
  }, jid)
  await page.waitForSelector('[data-message-list] pre', { timeout: 15_000 })
  await settle(page)
}

const distanceFromBottom = (page: Page) => page.evaluate(() => {
  const s = document.querySelector('[data-message-list]') as HTMLElement
  return s.scrollHeight - s.scrollTop - s.clientHeight
})

/** Wrap toggles currently mounted, last first, with the row they live in. */
const wrapButtons = (page: Page) => page.locator('[data-message-list] button[aria-pressed]')

const isWrapped = (button: ReturnType<Page['locator']>) => button.evaluate((b) => {
  const pre = b.closest('.rounded-lg')!.querySelector('pre')!
  return { wrapped: getComputedStyle(pre).whiteSpace === 'pre-wrap', overflows: pre.scrollWidth > pre.clientWidth + 1 }
})

test.describe('Wrap lines in the message list', () => {
  test('wraps in place, holds position, survives remount and chat switch', async ({ page }) => {
    await loadDemo(page)
    await seedRoom(page, ROOM, 10)
    await seedRoom(page, OTHER_ROOM, 7)
    await openRoom(page, ROOM)
    await scrollToBottom(page)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(AT_BOTTOM_OK_PX)

    // The last message is a long code block: it starts unwrapped with a sideways scroll.
    // The last message is a long code block: it starts unwrapped with a sideways scroll.
    const last = wrapButtons(page).last()
    expect(await isWrapped(last)).toEqual({ wrapped: false, overflows: true })
    const buttonTop = () => wrapButtons(page).last().evaluate((b) => b.getBoundingClientRect().top)
    const topBefore = await buttonTop()
    await last.click()
    await settle(page)
    // Wrapped: no sideways scroll. The click is an interaction, so (as for "Show more") the list
    // holds the clicked control in place and the block grows downward instead of jumping.
    expect(await isWrapped(wrapButtons(page).last())).toEqual({ wrapped: true, overflows: false })
    expect(Math.abs((await buttonTop()) - topBefore)).toBeLessThanOrEqual(2)
    // Back at the live edge the grown block ends exactly at the bottom of the list.
    await scrollToBottom(page)
    expect(await distanceFromBottom(page)).toBeLessThanOrEqual(AT_BOTTOM_OK_PX)

    // Reading position: scroll away from the live edge with real wheel input, as a reader does.
    // A wrap there grows the block downward; the block's top does not move.
    await wheelAwayFromBottom(page, 700)
    await settle(page)
    const target = page.locator('[data-message-list] button[aria-pressed="false"]').last()
    await expect(target).toBeVisible()
    // Follow the very block we click by its message id: the "first mounted" one can change as rows mount.
    const markedId = (await target.evaluate((b) => b.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null))!
    expect(markedId).not.toBeNull()
    // Bring the block into view first: a click would scroll it there and spoil the reference.
    await target.scrollIntoViewIfNeeded()
    await settle(page)
    const rowTop = () => page.evaluate((id) =>
      document.querySelector(`[data-message-id="${id}"] .rounded-lg`)?.getBoundingClientRect().top ?? null, markedId)
    const before = await rowTop()
    expect(before).not.toBeNull()
    await target.click()
    await settle(page)
    expect(Math.abs((await rowTop())! - before!)).toBeLessThanOrEqual(2)
    expect(await page.evaluate((id) => getComputedStyle(document.querySelector(`[data-message-id="${id}"] pre`)!).whiteSpace, markedId)).toBe('pre-wrap')

    // Chat switch and back: the choice is remembered; scroll away and back too.
    await openRoom(page, OTHER_ROOM)
    expect(await wrapButtons(page).evaluateAll((bs) => bs.filter((b) => b.getAttribute('aria-pressed') === 'true').length)).toBe(0)
    await openRoom(page, ROOM)
    const wrappedAfter = await page.evaluate((id) => {
      const row = Array.from(document.querySelectorAll('[data-message-id]')).find((r) => r.getAttribute('data-message-id') === id)
      const pre = row?.querySelector('pre')
      return pre ? getComputedStyle(pre).whiteSpace : null
    }, markedId)
    if (wrappedAfter !== null) expect(wrappedAfter).toBe('pre-wrap')
    else {
      // The row is virtualized out after reopening: scroll until it is mounted again.
      await page.evaluate((id) => {
        const s = document.querySelector('[data-message-list]') as HTMLElement
        for (let t = 0; t <= s.scrollHeight; t += 150) {
          s.scrollTop = t
          if (document.querySelector(`[data-message-id="${id}"] pre`)) return
        }
      }, markedId)
      await settle(page)
      const after = await page.evaluate((id) => {
        const pre = document.querySelector(`[data-message-id="${id}"] pre`)
        return pre ? getComputedStyle(pre).whiteSpace : null
      }, markedId)
      expect(after).toBe('pre-wrap')
    }

  })
})
