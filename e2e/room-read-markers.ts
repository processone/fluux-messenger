import { test, expect, type Page } from '@playwright/test'
import { createRequire } from 'node:module'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { settle, scrollToBottom, getMessageOffsetFromTop, sampleScrollTop } from './harness/scrollHarness'
import { LAUNCH_ROOM } from '../apps/fluux/src/demo/showcase/constants'

type Perf = { reset(): void; counts(): Record<string, number>; tally(): Record<string, number>; resetTally(): void }
type Scope = { __settingsStore: { getState(): { setThemeMode(mode: 'light' | 'dark'): void; setFontSize(size: number): void } }; __demoClient: DemoClient; __roomStore: typeof roomStore; __perf: Perf; __i18n: { changeLanguage(language: string): Promise<unknown> } }
type Box = { x: number; y: number; width: number; height: number }
const clearOf = (a: Box, b: Box) => a.x >= b.x + b.width || a.y >= b.y + b.height
  || a.x + a.width <= b.x || a.y + a.height <= b.y
const paragraphs = [
  { direction: 'ltr', body: 'The livestream and backup stream are ready. Please review the final launch checklist, confirm the stage backdrop, and keep the opening remarks within five minutes so the whole crew can follow the schedule.' },
  { direction: 'rtl', body: 'أصبح البث المباشر والبث الاحتياطي جاهزين. يرجى مراجعة قائمة الاستعدادات النهائية، والتأكد من خلفية المنصة، وحصر الكلمة الافتتاحية في خمس دقائق كي يتمكن جميع أعضاء الفريق من متابعة البرنامج.' },
] as const

async function openRoom(page: Page, width: number, scan = false, virtualized = false) {
  await page.setViewportSize({ width, height: 800 })
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  if (scan) {
    // React must see the packaged developer-tools hook while react-dom loads.
    await page.addInitScript({ path: createRequire(import.meta.url).resolve('react-scan/dist/install-hook.global.js') })
  }
  await bootDemo(page, `/demo.html?scene=showcase&tutorial=false&virt=${virtualized ? 1 : 0}${scan ? '&perf=scan' : ''}#/rooms/${encodeURIComponent(LAUNCH_ROOM)}`)
  if (scan) await page.waitForFunction(() => typeof (window as unknown as Scope).__perf?.reset === 'function')
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const fixture = await page.evaluate(async ({ roomJid, body }) => {
    const scope = window as unknown as Scope
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    const room = scope.__roomStore.getState().getRoom(roomJid)!
    const readers = [...room.occupants.values()].filter(person => person.nick !== room.nickname).slice(0, 5).sort((a, b) => a.occupantId!.localeCompare(b.occupantId!))
    const rows = scope.__roomStore.getState().messages.get(roomJid)!.filter(row => !row.isPrivate && !row.securityContext && !row.encryptedPayload && !row.contentAvailability)
    const prior = rows.at(-3)!, old = rows.at(-2)!, next = rows.at(-1)!
    const shortBody = old.body
    if (!prior.stanzaId || !old.stanzaId || !next.stanzaId || readers.length !== 5) throw new Error('Showcase room lacks marker fixture identities')
    // A normal paragraph, rather than the showcase's short mention or poll.
    await scope.__roomStore.getState().updateMessage(roomJid, old.id, {
      body,
      mentions: undefined, isMention: false, isEdited: false,
    })
    scope.__demoClient.roomReadMarkers.setEnabled(true)
    scope.__demoClient.roomReadMarkers.setRoomEnabled(roomJid, true)
    await scope.__demoClient.simulateRoomDisplayed(roomJid, readers[0].occupantId!, prior.stanzaId)
    return { shortBody, prior: prior.stanzaId, id: old.id, old: old.stanzaId, next: next.stanzaId, history: rows.map(row => ({ id: row.id, stanzaId: row.stanzaId! })), self: room.occupants.get(room.nickname)!.occupantId!, names: readers.map(reader => reader.nick), actors: readers.map(reader => reader.occupantId!), actor: readers[0].occupantId! }
  }, { roomJid: LAUNCH_ROOM, body: paragraphs[0].body })
  await expect(page.locator(`[data-message-list] [data-message-row-id][data-stanza-id="${fixture.old}"]`)).toBeVisible()
  await expect(page.locator('[data-virtualizer-spacer]')).toHaveCount(virtualized ? 1 : 0)
  return fixture
}

function showReaders(page: Page, actors: string[], target: string) {
  return page.evaluate(async ({ roomJid, actors, target }) => {
    for (const actor of actors) await (window as unknown as Scope).__demoClient.simulateRoomDisplayed(roomJid, actor, target)
  }, { roomJid: LAUNCH_ROOM, actors, target })
}

function addReaction(page: Page, target: string) {
  return page.evaluate(async ({ roomJid, target }) => {
    await (window as unknown as Scope).__demoClient.messages.sendReaction(roomJid, target, ['👍'])
  }, { roomJid: LAUNCH_ROOM, target })
}

// Source: the accepted short-line layout, overflow and accessibility plan.
// All measurements come from the built renderer, not substituted layout values.
async function checkRoomLineGeometry(page: Page, width: number) {
  const fixture = await openRoom(page, width, false, true)
  const oldRow = page.locator(`[data-message-row-id][data-stanza-id="${fixture.old}"]`)
  const marker = page.locator(`[data-read-marker-row="${fixture.old}"]`)
  await showReaders(page, fixture.actors, fixture.old)
  await addReaction(page, fixture.old)
  const readings: object[] = []
  for (const theme of ['light', 'dark'] as const) {
    for (const language of ['en', 'ar']) {
      for (const size of [100, 150]) {
        await page.evaluate(async ({ theme, language, size, id, body, roomJid }) => {
          const scope = window as unknown as Scope
          scope.__settingsStore.getState().setThemeMode(theme)
          scope.__settingsStore.getState().setFontSize(size)
          await scope.__i18n.changeLanguage(language)
          await scope.__roomStore.getState().updateMessage(roomJid, id, { body })
        }, { theme, language, size, id: fixture.id, body: paragraphs[language === 'ar' ? 1 : 0].body, roomJid: LAUNCH_ROOM })
        await page.evaluate(() => document.fonts.ready.then(() => undefined))
        await marker.scrollIntoViewIfNeeded()
        await expect(marker).toBeVisible()
        const link = marker.getByRole('button')
        await expect(link).toBeVisible()
        const reading = await marker.evaluate(element => {
          const rect = (node: Element) => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height } }
          const column = element.closest('[data-msg-column]')!
          const names = element.querySelector('[data-read-marker-names]')
          const button = element.querySelector('button')!
          const style = getComputedStyle(element)
          const buttonStyle = getComputedStyle(button)
          return { row: rect(element), column: rect(column), link: rect(button), text: names?.textContent ?? '',
            linkText: button.textContent!, fontSize: style.fontSize, color: style.color,
            italic: getComputedStyle(element.querySelector('.italic')!).fontStyle,
            namesStyle: names ? getComputedStyle(names).fontStyle : null,
            underline: buttonStyle.textDecorationLine, background: buttonStyle.backgroundColor,
            scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }
        })
        const shown = fixture.names.filter(name => reading.text.includes(name))
        const remaining = Number(reading.linkText.match(/\d+/)?.[0])
        expect(shown.length + remaining, 'visible names and remainder account for every peer').toBe(5)
        expect(shown.length).toBeLessThanOrEqual(3)
        if (width === 1280 && language === 'en' && size === 100) expect(shown).toHaveLength(3)
        expect(reading.italic).toBe('italic')
        if (shown.length) expect(reading.namesStyle).toBe('normal')
        expect(reading.underline).toContain('underline')
        const accessibleName = await link.getAttribute('aria-label')
        expect(accessibleName?.startsWith(reading.linkText)).toBe(true)
        expect(reading.background).toBe('rgba(0, 0, 0, 0)')
        expect(reading.link.height).toBeGreaterThanOrEqual(28)
        expect(reading.scrollWidth).toBeLessThanOrEqual(reading.clientWidth + 1)
        const text = (await oldRow.locator('[data-msg-text]').boundingBox())!
        const reaction = (await oldRow.locator('[data-reaction-emoji="👍"]').boundingBox())!
        expect(reading.row.y).toBeGreaterThanOrEqual(text.y + text.height)
        expect(reading.row.y).toBeGreaterThanOrEqual(reaction.y + reaction.height)
        expect(clearOf(reading.link, reaction)).toBe(true)
        expect(reading.link.x).toBeGreaterThanOrEqual(reading.column.x)
        expect(reading.link.x + reading.link.width).toBeLessThanOrEqual(reading.column.x + reading.column.width + 1)
        await expect(oldRow.locator('[data-read-marker-corner], [data-read-marker-avatar]')).toHaveCount(0)
        if (width === 320 && language === 'en' && size === 100) {
          await link.tap()
          const dialog = page.getByRole('dialog', { name: 'Read through this message' })
          for (const name of fixture.names) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
          await page.keyboard.press('Escape')
          await expect(dialog).toHaveCount(0)
          await expect(link).toBeFocused()
        }
        readings.push({ theme, language, size, width, ...reading })
      }
    }
  }
  await test.info().attach('room-marker-line-geometry', { body: JSON.stringify(readings, null, 2), contentType: 'application/json' })
}

for (const width of [1280, 320]) {
  test.describe(`read line viewport ${width}px`, () => {
    test.use({ hasTouch: width === 320 })
    test(`room read lines fit whole names and remain below content at ${width}px`, ({ page }) => checkRoomLineGeometry(page, width))
  })
}

for (const virtualized of [false, true]) {
  test(`room read lines keep exact lists, privacy and render isolation with virtualization ${virtualized}`, async ({ page }) => {
    const fixture = await openRoom(page, 1280, true, virtualized)
    const oldMarker = page.locator(`[data-read-marker-row="${fixture.old}"]`)
    const nextMarker = page.locator(`[data-read-marker-row="${fixture.next}"]`)
    await showReaders(page, fixture.actors.slice(0, 2), fixture.old)
    await expect(oldMarker.locator('[data-read-marker-names]')).toHaveText(`${fixture.names[0]} and ${fixture.names[1]}`)
    await expect(oldMarker.getByRole('button')).toHaveCount(0)
    await showReaders(page, [fixture.self], fixture.old)
    await expect(oldMarker.locator('[data-read-marker-names]')).toHaveText(`${fixture.names[0]} and ${fixture.names[1]}`)
    await showReaders(page, fixture.actors.slice(2), fixture.old)
    const opener = oldMarker.getByRole('button', { name: `+2 others: Read through this message: ${fixture.names.join(', ')}`, exact: true })
    await expect(opener).toHaveText('+2 others')
    await opener.scrollIntoViewIfNeeded()
    await page.keyboard.press('Tab')
    await opener.focus()
    const ring = await opener.evaluate(element => {
      const style = getComputedStyle(element)
      return { width: parseFloat(style.outlineWidth), offset: parseFloat(style.outlineOffset) }
    })
    expect(ring.width).toBeGreaterThan(0)
    expect(ring.width + ring.offset).toBeLessThanOrEqual(0)
    await opener.press('Space')
    const dialog = page.getByRole('dialog', { name: 'Read through this message' })
    for (const name of fixture.names) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
    await expect(dialog.getByText('Daniel', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
    await opener.click()
    await expect(dialog).toBeVisible()
    const shield = await page.evaluate(async () => {
      let frames = 0, points = 0
      const until = performance.now() + 650
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
      return { frames, points }
    })
    expect(shield.frames).toBeGreaterThan(0)
    expect(shield.points).toBeGreaterThan(0)
    await page.keyboard.press('Escape')
    await expect(opener).toBeFocused()
    const result = await page.evaluate(async ({ roomJid, actor, target }) => {
      const scope = window as unknown as Scope
      scope.__perf.reset(); scope.__perf.resetTally()
      const messages = scope.__roomStore.getState().messages.get(roomJid)
      await scope.__demoClient.simulateRoomDisplayed(roomJid, actor, target)
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
      return { counts: scope.__perf.counts(), tally: scope.__perf.tally(), sameMessages: messages === scope.__roomStore.getState().messages.get(roomJid) }
    }, { roomJid: LAUNCH_ROOM, actor: fixture.actor, target: fixture.next })
    await test.info().attach('room-marker-movement-renders', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
    expect(result.sameMessages).toBe(true)
    expect(result.counts.RoomReadBadge ?? 0).toBeGreaterThan(0)
    // Row-height measurements can update MessageList; peer movement must not
    // rerender the room or unrelated message bodies.
    for (const name of ['RoomView', 'RoomMessageList', 'RoomMessageBubbleWrapper', 'MessageBubble', 'MessageBody', 'MessageReactions']) {
      expect(result.counts[name] ?? 0, `${name} react-scan renders`).toBe(0)
      expect(result.tally[name] ?? 0, `${name} instrumented renders`).toBe(0)
    }
    await expect(nextMarker.locator('[data-read-marker-names]')).toHaveText(fixture.names[0])
    await expect(oldMarker.getByRole('button')).toHaveText('+1 other')
    await oldMarker.getByRole('button').click()
    await showReaders(page, fixture.actors.slice(1), fixture.next)
    await expect(oldMarker).toHaveCount(0)
    for (const name of fixture.names.slice(1)) await expect(dialog.getByText(name, { exact: true })).toBeVisible()
    await expect(dialog.getByText(fixture.names[0], { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-message-list]')).toBeFocused()
    await nextMarker.getByRole('button').click()
    await page.evaluate(roomJid => (window as unknown as Scope).__demoClient.roomReadMarkers.setRoomEnabled(roomJid, false), LAUNCH_ROOM)
    await expect(dialog).toHaveCount(0)
    await expect(page.locator('[data-read-marker-row]')).toHaveCount(0)
    await page.evaluate(roomJid => (window as unknown as Scope).__demoClient.roomReadMarkers.setRoomEnabled(roomJid, true), LAUNCH_ROOM)
    await expect(nextMarker).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await page.evaluate(() => (window as unknown as Scope).__demoClient.roomReadMarkers.setEnabled(false))
    await expect(page.locator('[data-read-marker-row]')).toHaveCount(0)
    await test.info().attach('room-marker-render-and-access', { body: JSON.stringify({ result, ring, shield }, null, 2), contentType: 'application/json' })
  })
}

for (const virtualized of [false, true]) {
  test(`room read line height changes preserve live edge and history with virtualization ${virtualized}`, async ({ page }) => {
    const fixture = await openRoom(page, 1280, false, virtualized)
    const early = fixture.history[1]
    const anchor = fixture.history[Math.floor(fixture.history.length / 2)]
    expect(fixture.history.length).toBeGreaterThan(5)
    await scrollToBottom(page)
    await settle(page)
    await showReaders(page, [fixture.actors[1]], early.stanzaId)
    await settle(page)
    const bottomDistance = await page.locator('[data-message-list]').evaluate(list => list.scrollHeight - list.scrollTop - list.clientHeight)
    expect(bottomDistance, 'adding a read line keeps the live edge pinned').toBeLessThanOrEqual(2)
    const anchorRow = page.locator(`[data-message-row-id][data-stanza-id="${anchor.stanzaId}"]`)
    await anchorRow.scrollIntoViewIfNeeded()
    await page.locator('[data-message-list]').hover()
    await page.mouse.wheel(0, -350)
    await settle(page)
    const parked = await getMessageOffsetFromTop(page, anchor.id)
    expect(parked).not.toBeNull()
    const away = await page.locator('[data-message-list]').evaluate(list => list.scrollHeight - list.scrollTop - list.clientHeight)
    expect(away, 'the history check is not following the live edge').toBeGreaterThan(100)
    await showReaders(page, [fixture.actors[1]], fixture.next)
    await settle(page)
    const after = await getMessageOffsetFromTop(page, anchor.id)
    expect(after).not.toBeNull()
    expect(Math.abs(after! - parked!), 'moving a line above the parked reader preserves their anchor').toBeLessThanOrEqual(2)
    const frames = await sampleScrollTop(page, 500)
    expect(frames.length).toBeGreaterThan(1)
    expect(Math.max(...frames) - Math.min(...frames), 'the settled reading view does not drift').toBeLessThanOrEqual(2)
    await test.info().attach('room-marker-scroll', { body: JSON.stringify({ virtualized, bottomDistance, away, parked, after, frames }), contentType: 'application/json' })
  })
}
