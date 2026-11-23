import { test, expect, type Locator } from '@playwright/test'
import { createRequire } from 'node:module'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { LAUNCH_ROOM } from '../apps/fluux/src/demo/showcase/constants'

type Perf = { reset(): void; counts(): Record<string, number>; tally(): Record<string, number>; resetTally(): void }
type Scope = { __demoClient: DemoClient; __roomStore: typeof roomStore; __perf: Perf; __i18n: { changeLanguage(language: string): Promise<unknown> } }
type Box = { x: number; y: number; width: number; height: number }
const clearOf = (a: Box, b: Box) => a.x >= b.x + b.width || a.y >= b.y + b.height
  || a.x + a.width <= b.x || a.y + a.height <= b.y
const paragraphs = [
  { direction: 'ltr', body: 'The livestream and backup stream are ready. Please review the final launch checklist, confirm the stage backdrop, and keep the opening remarks within five minutes so the whole crew can follow the schedule.' },
  { direction: 'rtl', body: 'أصبح البث المباشر والبث الاحتياطي جاهزين. يرجى مراجعة قائمة الاستعدادات النهائية، والتأكد من خلفية المنصة، وحصر الكلمة الافتتاحية في خمس دقائق كي يتمكن جميع أعضاء الفريق من متابعة البرنامج.' },
] as const

// Source: the approved app/render check. This is a real renderer with the demo
// transport stand-in, not evidence of the real server's eligibility or identity.
test('room read badges cap avatars, name every reader and move without rendering the timeline', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  // React must see the packaged developer-tools hook while react-dom loads.
  await page.addInitScript({ path: createRequire(import.meta.url).resolve('react-scan/dist/install-hook.global.js') })
  await bootDemo(page, `/demo.html?perf=scan&scene=showcase&tutorial=false#/rooms/${encodeURIComponent(LAUNCH_ROOM)}`)
  await page.waitForFunction(() => typeof (window as unknown as Scope).__perf?.reset === 'function')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const fixture = await page.evaluate(async ({ roomJid, body }) => {
    const scope = window as unknown as Scope
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    const room = scope.__roomStore.getState().getRoom(roomJid)!
    const readers = [...room.occupants.values()].filter(person => person.nick !== room.nickname).slice(0, 4)
    const rows = scope.__roomStore.getState().messages.get(roomJid)!.filter(row => !row.isPrivate && !row.securityContext && !row.encryptedPayload && !row.contentAvailability)
    const prior = rows.at(-3)!, old = rows.at(-2)!, next = rows.at(-1)!
    const shortBody = old.body
    if (!prior.stanzaId || !old.stanzaId || !next.stanzaId || readers.length !== 4) throw new Error('Showcase room lacks marker fixture identities')
    // A normal paragraph, rather than the showcase's short mention or poll.
    await scope.__roomStore.getState().updateMessage(roomJid, old.id, {
      body,
      mentions: undefined, isMention: false, isEdited: false,
    })
    // Establish qualification before measuring: every row keeps the same corner
    // space whether or not that row currently holds a badge.
    await scope.__demoClient.simulateRoomDisplayed(roomJid, readers[0].occupantId!, prior.stanzaId)
    return { shortBody, prior: prior.stanzaId, id: old.id, old: old.stanzaId, next: next.stanzaId, names: readers.map(reader => reader.nick), actors: readers.map(reader => reader.occupantId!), actor: readers[0].occupantId! }
  }, { roomJid: LAUNCH_ROOM, body: paragraphs[0].body })
  const oldRow = page.locator(`[data-message-row-id][data-stanza-id="${fixture.old}"]`)
  const layouts = paragraphs.flatMap(message => ['ltr', 'rtl'].flatMap(direction => [1280, 390].map(width => ({ message, direction, width }))))
  const applyLayout = async ({ message, direction, width }: typeof layouts[number]) => {
    await page.evaluate(async ({ roomJid, id, body, direction }) => {
      const scope = window as unknown as Scope
      await scope.__i18n.changeLanguage(direction === 'rtl' ? 'ar' : 'en')
      await scope.__roomStore.getState().updateMessage(roomJid, id, { body, isEdited: false })
    }, { roomJid: LAUNCH_ROOM, id: fixture.id, body: message.body, direction })
    await expect(page.locator('html')).toHaveAttribute('lang', direction === 'rtl' ? 'ar' : 'en')
    await expect(page.locator('html')).toHaveAttribute('dir', direction)
    await expect(oldRow.locator('[data-msg-text]')).toHaveText(message.body)
    await page.evaluate(() => document.fonts.ready.then(() => undefined))
    await page.setViewportSize({ width, height: 800 })
    await oldRow.scrollIntoViewIfNeeded()
  }
  const geometryReadings: object[] = []
  // The readable-corner check also protects the following row's content.
  const checkFollowingRow = async (badge: Box, tap: Box, following: Locator) => {
    const nextColumn = (await following.locator('[data-msg-column]').first().boundingBox())!
    const reading = { state: 'following-row-clearance', badge, tap, nextColumn }
    geometryReadings.push(reading)
    const bottom = Math.max(badge.y + badge.height, tap.y + tap.height)
    if (bottom > nextColumn.y) await test.info().attach('room-marker-next-row-overlap', { body: JSON.stringify(reading, null, 2), contentType: 'application/json' })
    expect(bottom,
      'the paint and tap area leave the following message unobscured').toBeLessThanOrEqual(nextColumn.y)
  }
  await page.evaluate(async ({ roomJid, id, body }) => {
    await (window as unknown as Scope).__roomStore.getState().updateMessage(roomJid, id, { body })
  }, { roomJid: LAUNCH_ROOM, id: fixture.id, body: fixture.shortBody })
  await expect(oldRow.locator('[data-msg-text]')).toHaveText(fixture.shortBody)
  const singleLine = await oldRow.evaluate(element => {
    const corner = element.querySelector<HTMLElement>('[data-read-marker-corner]')!
    const reserved = element.getBoundingClientRect().height
    corner.style.display = 'none'
    const unreserved = element.getBoundingClientRect().height
    corner.style.removeProperty('display')
    return { reserved, unreserved }
  })
  expect(singleLine.reserved, 'the trailing spacer adds no fixed row height').toBe(singleLine.unreserved)
  geometryReadings.push({ state: 'one-line-without-readers', ...singleLine })
  const priorRow = page.locator(`[data-message-row-id][data-stanza-id="${fixture.prior}"]`)
  const priorBadge = page.locator(`[data-read-marker-row="${fixture.prior}"]`)
  // The preceding showcase poll exercises structured content, not just prose.
  for (const layout of layouts.filter(layout => layout.message.direction === 'ltr')) {
    await applyLayout(layout)
    await priorRow.scrollIntoViewIfNeeded()
    await expect(priorBadge).toBeVisible()
    const badge = (await priorBadge.boundingBox())!
    const surface = (await priorBadge.locator('[data-read-marker-surface]').boundingBox())!
    const tap = (await priorBadge.getByRole('button').boundingBox())!
    await checkFollowingRow(surface, tap, oldRow)
    const controls = await priorRow.locator('button').evaluateAll(buttons => buttons
      .filter(button => !button.closest('[data-read-marker-row]'))
      .map(button => { const rect = button.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height } })
      .filter(rect => rect.width > 0 && rect.height > 0))
    for (const control of controls) expect(clearOf(badge, control), 'the badge leaves structured-card controls unobscured').toBe(true)
    geometryReadings.push({ state: 'structured-poll', direction: layout.direction, width: layout.width, badge, controls })
  }
  await oldRow.scrollIntoViewIfNeeded()
  await expect(oldRow.locator('[data-read-marker-corner]')).toHaveCount(1)
  const heights = new Map<string, number>()
  for (const layout of layouts) {
    await applyLayout(layout)
    heights.set(`${layout.message.direction}-${layout.direction}-${layout.width}`, (await oldRow.boundingBox())!.height)
  }
  await page.evaluate(async ({ roomJid, actors, target }) => {
    for (const actor of actors) await (window as unknown as Scope).__demoClient.simulateRoomDisplayed(roomJid, actor, target)
  }, { roomJid: LAUNCH_ROOM, actors: fixture.actors, target: fixture.old })
  const oldBadge = page.locator(`[data-read-marker-row="${fixture.old}"]`)
  const nextRow = page.locator(`[data-message-row-id][data-stanza-id="${fixture.next}"]`)
  const checkGeometry = async (expected: Map<string, number> | undefined, reactions: boolean) => {
    const measured = new Map<string, number>()
    for (const layout of layouts) {
      await applyLayout(layout)
      const { message, direction, width } = layout
      const key = `${message.direction}-${direction}-${width}`
      await expect(oldBadge).toBeVisible()
      const height = (await oldRow.boundingBox())!.height
      measured.set(key, height)
      if (expected) expect(height, 'a reader move does not resize a qualified row').toBe(expected.get(key))
      const badge = (await oldBadge.locator('[data-read-marker-surface]').boundingBox())!
      const tap = (await oldBadge.getByRole('button').boundingBox())!
      const column = (await oldRow.locator('[data-msg-column]').boundingBox())!
      const avatar = (await oldRow.locator('[data-msg-avatar-column]').boundingBox())!
      expect(badge.height, 'the visible badge stays compact').toBe(24)
      expect(tap.height, 'the transparent tap target remains reachable').toBe(28)
      expect(tap.x).toBeGreaterThanOrEqual(column.x)
      expect(tap.x + tap.width).toBeLessThanOrEqual(column.x + column.width)
      expect(clearOf(tap, avatar), 'the tap area never covers the avatar or its gutter').toBe(true)
      if (reactions) {
        const reaction = (await oldRow.locator('[data-reaction-emoji="👍"]').boundingBox())!
        expect(clearOf(badge, reaction),
        'the corner badge leaves the reaction control unobscured').toBe(true)
      }
      const textRects = await oldRow.locator('[data-msg-text]').first().evaluate(element => {
        const rects: Box[] = []
        const text = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
        for (let node = text.nextNode(); node; node = text.nextNode()) {
          const range = document.createRange(); range.selectNodeContents(node)
          for (const { x, y, width, height } of range.getClientRects()) {
            if (width && height) rects.push({ x, y, width, height })
          }
        }
        return rects
      })
      const textClear = textRects.every(rect => clearOf(badge, rect))
      const reading = { direction, textDirection: message.direction, width, rowHeight: height, badge, tap, column, avatar, reactions, textClear, textRects }
      geometryReadings.push(reading)
      if (!textClear) await test.info().attach('room-marker-text-overlap', { body: JSON.stringify(reading, null, 2), contentType: 'application/json' })
      expect(textClear, 'the long paragraph stays readable, including at phone width').toBe(true)
      await checkFollowingRow(badge, tap, nextRow)
    }
    await applyLayout({ message: paragraphs[0], direction: 'ltr', width: 1280 })
    return measured
  }
  // Cover both the original text-only defect and the adjacent reaction controls.
  await checkGeometry(heights, false)
  await page.evaluate(async ({ roomJid, target }) => {
    await (window as unknown as Scope).__demoClient.messages.sendReaction(roomJid, target, ['👍'])
  }, { roomJid: LAUNCH_ROOM, target: fixture.old })
  await expect(oldRow.locator('[data-reaction-emoji="👍"]')).toBeVisible()
  const reactionHeights = await checkGeometry(undefined, true)
  const opener = oldBadge.getByRole('button', { name: `Read through this message: ${fixture.names.join(', ')}`, exact: true })
  await expect(opener).toBeVisible()
  await expect(opener.getByText('+1', { exact: true })).toBeVisible()
  // Establish real keyboard modality before checking the visible focus outline.
  await page.keyboard.press('Tab')
  await opener.focus()
  const ring = await opener.evaluate(element => {
    const style = getComputedStyle(element)
    return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) }
  })
  geometryReadings.push({ state: 'keyboard-focus-ring', ring })
  expect(ring.width, 'the focused badge has a visible keyboard ring').toBeGreaterThan(0)
  expect(ring.width + ring.offset, 'the keyboard ring stays inside the tap area').toBeLessThanOrEqual(0)
  // Native keyboard activation and the full named list.
  await opener.press('Space')
  const dialog = page.getByRole('dialog', { name: 'Read through this message' })
  for (const name of fixture.names) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(opener).toBeFocused()
  // A mouseup can re-arm the row toolbar after the list opens. Observe the
  // complete exposure window, failing on any click-through, rather than sleeping.
  await opener.click()
  await expect(dialog).toBeVisible()
  const shield = await page.evaluate(async () => {
    const until = performance.now() + 650
    const started = performance.now()
    let frames = 0
    let points = 0
    do {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      const overlay = document.querySelector('[data-modal="true"]')!
      for (const control of document.querySelectorAll('button, [role="button"]')) {
        if (overlay.contains(control)) continue
        const rect = control.getBoundingClientRect()
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2
        if (!rect.width || !rect.height || x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue
        if (!overlay.contains(document.elementFromPoint(x, y))) throw new Error('Reader list exposes an underlying control')
        points++
      }
      frames++
    } while (performance.now() < until)
    return { frames, points, durationMs: performance.now() - started }
  })
  expect(shield.frames).toBeGreaterThan(0)
  expect(shield.points).toBeGreaterThan(0)
  await test.info().attach('room-marker-dialog-shield', { body: JSON.stringify(shield), contentType: 'application/json' })
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
  await checkGeometry(reactionHeights, true)
  // Readers have still read through this row after advancing beyond it. Keep
  // their open list stable even when its live badge has no readers left.
  await oldBadge.getByRole('button', { name: `Read through this message: ${fixture.names.slice(1).join(', ')}`, exact: true }).click()
  await expect(dialog).toBeVisible()
  await page.evaluate(async ({ roomJid, actors, target }) => {
    for (const actor of actors) await (window as unknown as Scope).__demoClient.simulateRoomDisplayed(roomJid, actor, target)
  }, { roomJid: LAUNCH_ROOM, actors: fixture.actors.slice(1), target: fixture.next })
  await expect(oldBadge).toHaveCount(0)
  await expect(dialog).toBeVisible()
  for (const name of fixture.names.slice(1)) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await test.info().attach('room-marker-corner-geometry', { body: JSON.stringify(geometryReadings, null, 2), contentType: 'application/json' })
  await test.info().attach('room-marker-render-counts', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
})
