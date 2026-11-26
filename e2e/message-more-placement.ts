import { expect, test } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'

type Demo = Window & { __demoClient: DemoClient; __roomStore: typeof roomStore; __settingsStore: typeof useSettingsStore }
const ROOM = 'team@conference.fluux.chat'

// Owns the reported compose-bar clipping invariant, including wrapped French labels.
for (const virtualized of [true, false]) for (const latest of [true, false]) {
  test(`${virtualized ? 'virtualized' : 'plain'} ${latest ? 'latest' : 'higher'} More menu stays above the composer`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1200, height: 700 })
    await page.addInitScript(() => localStorage.setItem('i18nextLng', 'fr'))
    await bootDemo(page, `/demo.html?tutorial=false&virt=${virtualized ? 1 : 0}`)
    await page.evaluate(async ROOM => {
      const scope = window as unknown as Demo
      scope.__demoClient.stopAnimation()
      scope.__settingsStore.getState().setThemeMode('dark')
      scope.__settingsStore.getState().setFontSize(110)
      const rooms = scope.__roomStore.getState()
      await rooms.activateRoom(ROOM)
      const room = rooms.rooms.get(ROOM)!
      const self = room.occupants.get(room.nickname!)!
      const participant = { ...self, role: 'participant' as const, affiliation: 'member' as const }
      scope.__demoClient.emitSDK('room:occupants-batch', { roomJid: ROOM, occupants: [participant] })
      scope.__demoClient.emitSDK('room:self-occupant', { roomJid: ROOM, occupant: participant })
      for (const [index, [id, nick, body]] of [
        ['menu-compose-higher', 'Emma', 'I’ll go through the remaining review tasks this afternoon.'],
        ['menu-compose-previous', 'Liam', 'Thanks, I’ll add the examples to the draft.'],
        ['menu-compose-latest', 'Emma', 'The command example is ready for review.'],
      ].entries()) {
        scope.__demoClient.emitSDK('room:message', { roomJid: ROOM, isLiveArrival: true, message: {
          type: 'groupchat', id, originId: undefined, roomJid: ROOM, stanzaId: `sid-${id}`, from: `${ROOM}/${nick}`, nick,
          occupantId: `demo-team-${nick}`, body, timestamp: new Date(Date.now() - (3 - index) * 60_000), isOutgoing: false,
        } })
      }
      location.hash = `#/rooms/${encodeURIComponent(ROOM)}`
    }, ROOM)
    const list = page.locator('[data-message-list]')
    await expect.poll(() => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(1)
    await expect(list.locator('[data-virtualizer-spacer]')).toHaveCount(virtualized ? 1 : 0)
    const id = latest ? 'menu-compose-latest' : 'menu-compose-higher'
    const row = page.locator(`[data-message-id="${id}"][data-message-body]`)
    await row.hover()
    const toolbar = row.locator('[data-message-toolbar]')
    await toolbar.evaluate(async el => { for (const animation of el.getAnimations()) await animation.finished })
    await expect(toolbar).toHaveCSS('opacity', '1')
    const trigger = toolbar.getByRole('button', { name: "Plus d'options", exact: true })
    const box = (await trigger.boundingBox())!
    // Coordinate clicks cannot scroll a clipped target into view and hide the defect.
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const menu = row.locator('[data-message-panel="more"]')
    await expect(menu).toBeVisible()
    const reading = await menu.evaluate(element => {
      const list = element.closest('[data-message-list]')!
      const panel = element.getBoundingClientRect()
      const bounds = list.getBoundingClientRect()
      const compose = document.querySelector('.composer-card')!.getBoundingClientRect()
      const hit = (x: number, y: number, target: Element) => target.contains(document.elementFromPoint(x, y))
      const actions = [...element.querySelectorAll('button')].map(action => {
        const rect = action.getBoundingClientRect()
        const label = [...action.childNodes].find(n => n.nodeType === Node.TEXT_NODE && n.textContent?.trim())!
        const range = document.createRange()
        range.selectNodeContents(label)
        return { label: label.textContent, enabled: !action.disabled,
          centerHit: hit(rect.x + rect.width / 2, rect.y + rect.height / 2, action),
          lines: [...range.getClientRects()].map(line => ({
            topHit: hit(line.x + line.width / 2, line.top + 1, action),
            bottomHit: hit(line.x + line.width / 2, line.bottom - 1, action),
          })) }
      })
      return { up: element.classList.contains('bottom-full'), top: panel.top, bottom: panel.bottom,
        listTop: bounds.top, listBottom: bounds.bottom, composeTop: compose.top, actions }
    })
    await testInfo.attach('menu-geometry', { body: JSON.stringify(reading, null, 2), contentType: 'application/json' })
    await testInfo.attach('menu', { body: await page.screenshot(), contentType: 'image/png' })
    expect(reading.up).toBe(latest)
    expect(reading.top).toBeGreaterThanOrEqual(reading.listTop - 1)
    expect(reading.bottom).toBeLessThanOrEqual(Math.min(reading.listBottom, reading.composeTop) + 1)
    expect(reading.actions.map(action => action.label)).toEqual(['Enregistrer le message', 'Copier le lien du message'])
    for (const action of reading.actions) {
      expect(action.enabled).toBe(true)
      expect(action.centerHit, action.label!).toBe(true)
      expect(action.lines.length).toBeGreaterThan(0)
      for (const line of action.lines) {
        expect(line.topHit, action.label!).toBe(true)
        expect(line.bottomHit, action.label!).toBe(true)
      }
    }
  })
}
