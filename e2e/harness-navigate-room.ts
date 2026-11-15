import { test, expect } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import { loadDemo, activateChat, navigateToStressRoom, STRESS_ROOM_JID } from './harness/scrollHarness'

/**
 * The room helper must publish its destination before awaiting cache hydration. A delayed
 * Messages route can otherwise cancel that hydration while the helper waits for an active room
 * before changing the route. Hold the real cache read to force that ordering without a sleep.
 */
for (const virtualized of [false, true]) {
  test(`navigateToStressRoom survives a competing Messages route (virtualized: ${virtualized})`, async ({ page }, testInfo) => {
    await loadDemo(page)
    // Ensure the queued Messages route changes the current route, regardless of demo ordering.
    await activateChat(page, 'ava@fluux.chat')
    await page.evaluate(({ jid, virtualized }) => {
      const scope = window as unknown as {
        __roomStore: typeof roomStore
        __demoClient: { stopAnimation(): void }
        __roomNavigationOrder?: { event: string; route: string; pending: boolean }[]
      }
      scope.__demoClient.stopAnimation()
      localStorage.setItem('fluux:flags:enableMessageVirtualization', String(virtualized))
      const store = scope.__roomStore
      const { activateRoom, loadMessagesFromCache } = store.getState()
      const order: NonNullable<typeof scope.__roomNavigationOrder> = []
      scope.__roomNavigationOrder = order
      let firstActivation = true
      let firstRead = true
      let releaseRead: (() => void) | undefined
      const record = (event: string) => order.push({
        event, route: location.hash, pending: store.getState().activationPending,
      })
      store.setState({
        loadMessagesFromCache: async (roomJid, options) => {
          const read = loadMessagesFromCache(roomJid, options)
          if (roomJid === jid && firstRead) {
            firstRead = false
            await new Promise<void>(resolve => { releaseRead = resolve })
          }
          return read
        },
        activateRoom: roomJid => {
          const activation = activateRoom(roomJid)
          if (roomJid === jid && firstActivation) {
            firstActivation = false
            // Model the startup Messages navigation arriving during the harness's hydration.
            // The helper must replace this route in the same task, not after awaiting activation.
            location.hash = '#/messages/' + encodeURIComponent('james@fluux.chat')
            record('messages-route-queued')
          } else if (releaseRead) {
            // ChatLayout has committed a route: either it cancels the room on Messages (the bug),
            // or its Rooms URL sync reactivates the requested room (the intended convergence).
            record(roomJid === null ? 'room-cancelled' : 'room-reactivated')
            releaseRead()
            releaseRead = undefined
          }
          return activation
        },
      })
    }, { jid: STRESS_ROOM_JID, virtualized })

    try {
      await navigateToStressRoom(page, virtualized)
      const state = await page.evaluate(() => {
        const scope = window as unknown as {
          __roomStore: typeof roomStore
          __roomNavigationOrder: { event: string; route: string; pending: boolean }[]
        }
        const room = scope.__roomStore.getState()
        return {
          active: room.activeRoomJid,
          pending: room.activationPending,
          route: location.hash,
          order: scope.__roomNavigationOrder,
          roomMessageIds: room.messages.get(room.activeRoomJid!)?.map(message => message.id) ?? [],
          renderedMessageIds: Array.from(document.querySelectorAll<HTMLElement>(
            '[data-message-list] .message-row[data-message-id]',
          )).map(row => row.dataset.messageId!),
        }
      })
      await testInfo.attach('room-navigation-state', { body: JSON.stringify(state, null, 2), contentType: 'application/json' })
      expect(state.order).toEqual([
        { event: 'messages-route-queued', route: '#/messages/' + encodeURIComponent('james@fluux.chat'), pending: true },
        { event: 'room-reactivated', route: '#/rooms/' + encodeURIComponent(STRESS_ROOM_JID), pending: true },
      ])
      expect(state).toMatchObject({
        active: STRESS_ROOM_JID, pending: false, route: '#/rooms/' + encodeURIComponent(STRESS_ROOM_JID),
      })
      expect(state.renderedMessageIds.length).toBeGreaterThan(0)
      for (const id of state.renderedMessageIds) expect(state.roomMessageIds).toContain(id)
      await expect(page.locator('[data-message-list]')).toBeVisible()
      await expect(page.locator(virtualized ? '[data-index]' : '.message-row[data-message-id]').first()).toBeVisible()
    } finally {
      await testInfo.attach('room-navigation-order', {
        body: JSON.stringify(await page.evaluate(() => {
          const scope = window as unknown as {
            __roomStore: typeof roomStore
            __roomNavigationOrder: unknown
          }
          const room = scope.__roomStore.getState()
          return { active: room.activeRoomJid, pending: room.activationPending, route: location.hash, order: scope.__roomNavigationOrder }
        }), null, 2),
        contentType: 'application/json',
      })
    }
  })
}
