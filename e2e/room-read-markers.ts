import { test, expect } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { LAUNCH_ROOM } from '../apps/fluux/src/demo/showcase/constants'

type Perf = { reset(): void; counts(): Record<string, number>; tally(): Record<string, number>; resetTally(): void }
type Scope = { __demoClient: DemoClient; __roomStore: typeof roomStore; __perf: Perf }

// Source: the approved app/render check. This is a real renderer with the demo
// transport stand-in, not evidence of the real server's eligibility or identity.
test('room read badges cap avatars, name every reader and move without rendering the timeline', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?perf=1&scene=showcase&tutorial=false#/rooms/${encodeURIComponent(LAUNCH_ROOM)}`)
  await page.waitForFunction(() => typeof (window as unknown as Scope).__perf?.reset === 'function')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const fixture = await page.evaluate(async roomJid => {
    const scope = window as unknown as Scope
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    const room = scope.__roomStore.getState().getRoom(roomJid)!
    const readers = [...room.occupants.values()].filter(person => person.nick !== room.nickname).slice(0, 4)
    const rows = scope.__roomStore.getState().messages.get(roomJid)!.filter(row => !row.isPrivate && !row.securityContext && !row.encryptedPayload && !row.contentAvailability)
    const old = rows.at(-3)!, next = rows.at(-2)!
    if (!old.stanzaId || !next.stanzaId || readers.length !== 4) throw new Error('Showcase room lacks marker fixture identities')
    await scope.__demoClient.messages.sendReaction(roomJid, old.stanzaId, ['👍'])
    return { old: old.stanzaId, next: next.stanzaId, names: readers.map(reader => reader.nick), actors: readers.map(reader => reader.occupantId!), actor: readers[0].occupantId! }
  }, LAUNCH_ROOM)
  const oldRow = page.locator(`[data-message-row-id][data-stanza-id="${fixture.old}"]`)
  const layouts = [
    { direction: 'ltr', width: 1280 }, { direction: 'ltr', width: 390 },
    { direction: 'rtl', width: 1280 }, { direction: 'rtl', width: 390 },
  ] as const
  const heights = new Map<string, number>()
  for (const { direction, width } of layouts) {
    await page.evaluate(direction => { document.documentElement.dir = direction }, direction)
    await page.setViewportSize({ width, height: 800 })
    await oldRow.scrollIntoViewIfNeeded()
    await expect(oldRow.locator('[data-reaction-emoji="👍"]')).toBeVisible()
    heights.set(`${direction}-${width}`, (await oldRow.boundingBox())!.height)
  }
  await page.evaluate(async ({ roomJid, actors, target }) => {
    for (const actor of actors) await (window as unknown as Scope).__demoClient.simulateRoomDisplayed(roomJid, actor, target)
  }, { roomJid: LAUNCH_ROOM, actors: fixture.actors, target: fixture.old })
  const oldBadge = page.locator(`[data-read-marker-row="${fixture.old}"]`)
  await oldBadge.scrollIntoViewIfNeeded()
  for (const { direction, width } of layouts) {
    await page.evaluate(direction => { document.documentElement.dir = direction }, direction)
    await page.setViewportSize({ width, height: 800 })
    await oldRow.scrollIntoViewIfNeeded()
    await expect(oldBadge).toBeVisible()
    expect((await oldRow.boundingBox())!.height, 'the overlay adds no row height').toBe(heights.get(`${direction}-${width}`))
    const badge = (await oldBadge.boundingBox())!
    const reaction = (await oldRow.locator('[data-reaction-emoji="👍"]').boundingBox())!
    expect(badge.x >= reaction.x + reaction.width || badge.y >= reaction.y + reaction.height
      || badge.x + badge.width <= reaction.x || badge.y + badge.height <= reaction.y,
    'the trailing-corner badge leaves the reaction control unobscured').toBe(true)
    const body = oldRow.locator('[data-message-body]')
    const textClear = await body.evaluate((element, badge) => {
      const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = text.nextNode(); node; node = text.nextNode()) {
        const range = document.createRange(); range.selectNodeContents(node)
        if (![...range.getClientRects()].every(rect => !rect.width || !rect.height || badge.x >= rect.right || badge.y >= rect.bottom
          || badge.x + badge.width <= rect.left || badge.y + badge.height <= rect.top)) return false
      }
      return true
    }, badge)
    expect(textClear, 'the overlay leaves message text unobscured').toBe(true)
  }
  await page.evaluate(() => { document.documentElement.dir = 'ltr' })
  await page.setViewportSize({ width: 1280, height: 800 })
  const opener = oldBadge.getByRole('button', { name: `Read through this message: ${fixture.names.join(', ')}`, exact: true })
  await expect(opener).toBeVisible()
  await expect(opener.getByText('+1', { exact: true })).toBeVisible()
  // Native keyboard activation and the full named list.
  await opener.focus(); await opener.press('Space')
  const dialog = page.getByRole('dialog', { name: 'Read through this message' })
  for (const name of fixture.names) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  // Wait for a completed render/layout turn before the spaced update, not a sleep.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const result = await page.evaluate(async ({ roomJid, actor, target }) => {
    const scope = window as unknown as Scope
    scope.__perf.reset(); scope.__perf.resetTally()
    const messages = scope.__roomStore.getState().messages.get(roomJid)
    await scope.__demoClient.simulateRoomDisplayed(roomJid, actor, target)
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    return { counts: scope.__perf.counts(), tally: scope.__perf.tally(), sameMessages: messages === scope.__roomStore.getState().messages.get(roomJid) }
  }, { roomJid: LAUNCH_ROOM, actor: fixture.actor, target: fixture.next })
  expect(result.sameMessages).toBe(true)
  expect(result.counts.RoomReadBadge ?? 0, 'the render probe observed the changed badges').toBeGreaterThan(0)
  expect(result.counts.RoomReadBadge, 'only old/new badges, including StrictMode double rendering').toBeLessThanOrEqual(4)
  for (const name of ['RoomView', 'RoomMessageList', 'RoomMessageBubbleWrapper', 'MessageList']) {
    expect(result.counts[name] ?? 0, `${name} react-scan renders`).toBe(0)
    expect(result.tally[name] ?? 0, `${name} instrumented renders`).toBe(0)
  }
  await expect(page.locator(`[data-read-marker-row="${fixture.next}"]`).getByRole('button', { name: `Read through this message: ${fixture.names[0]}`, exact: true })).toBeVisible()
  await expect(oldBadge.getByText('+1', { exact: true })).toHaveCount(0)
  await test.info().attach('room-marker-render-counts', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
})
