import { test, expect } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import { loadDemo, activateChat, navigateToStressRoom, STRESS_ROOM_JID } from './harness/scrollHarness'

/**
 * Observe the first route event while cache hydration is held. Matching pending activation is
 * intentionally reused, so a second activation is not a reliable signal that routing committed.
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
        __roomRouteObserved?: Promise<{ route: string; pending: boolean }>
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
      scope.__roomRouteObserved = new Promise(resolve => {
        window.addEventListener('hashchange', () => {
          record('route-published')
          const observed = { route: location.hash, pending: store.getState().activationPending }
          releaseRead?.()
          releaseRead = undefined
          resolve(observed)
        }, { once: true })
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
          }
          return activation
        },
      })
    }, { jid: STRESS_ROOM_JID, virtualized })

    const publication = page.evaluate(() => (window as unknown as {
      __roomRouteObserved: Promise<{ route: string; pending: boolean }>
    }).__roomRouteObserved).then(async observed => {
      await testInfo.attach('room-route-publication', {
        body: JSON.stringify(observed), contentType: 'application/json',
      })
      expect(observed).toEqual({
        route: '#/rooms/' + encodeURIComponent(STRESS_ROOM_JID), pending: true,
      })
    })
    await Promise.all([publication, navigateToStressRoom(page, virtualized)])
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
      { event: 'route-published', route: '#/rooms/' + encodeURIComponent(STRESS_ROOM_JID), pending: true },
    ])
    expect(state).toMatchObject({
      active: STRESS_ROOM_JID, pending: false, route: '#/rooms/' + encodeURIComponent(STRESS_ROOM_JID),
    })
    expect(state.renderedMessageIds.length).toBeGreaterThan(0)
    for (const id of state.renderedMessageIds) expect(state.roomMessageIds).toContain(id)
    await expect(page.locator('[data-message-list]')).toBeVisible()
    await expect(page.locator(virtualized ? '[data-index]' : '.message-row[data-message-id]').first()).toBeVisible()
  })
}
