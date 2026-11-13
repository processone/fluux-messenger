import { test, expect } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { waitForActions } from './harness/messageInteraction'
import { ROOM_JID as ROOM } from '../apps/fluux/src/demo/constants'

// Room links (docs/URL_SCHEMES.md): copy a link, receive it in another chat, click
// it inside Fluux and land on the highlighted row. Demo history is the fixture;
// clipboard observation replaces the OS clipboard in this browser integration
// test. Actual archive and native launch boundaries have separate live scenarios.
test('copy a room message link and jump to it from another chat', async ({ page }) => {
  let copied = ''
  await page.exposeFunction('__captureMessageLink', (value: string) => { copied = value })
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => (window as unknown as { __captureMessageLink: (text: string) => Promise<void> }).__captureMessageLink(text),
    } })
    localStorage.setItem('i18nextLng', 'en')
  })
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  const targetId = 'demo-room-whisper-pub'
  const stanzaId = await page.evaluate(async ({ roomJid, targetId }) => {
    const scope = window as unknown as { __demoClient: DemoClient; __roomStore: typeof roomStore }
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    return scope.__roomStore.getState().messages.get(roomJid)!.find(row => row.id === targetId)!.stanzaId!
  }, { roomJid: ROOM, targetId })
  const row = page.locator(`[data-message-id="${targetId}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, targetId)
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  await row.getByRole('button', { name: 'Copy message link', exact: true }).click()
  await expect.poll(() => copied).toBe(`xmpp:${ROOM}?join;msg=${encodeURIComponent(stanzaId)}`)

  await page.evaluate(link => {
    const scope = window as unknown as { __demoClient: DemoClient }
    const peer = 'emma@fluux.chat'
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'shared-room-link', conversationId: peer, from: peer, body: link,
      stanzaId: undefined, originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
    location.hash = `#/messages/${encodeURIComponent(peer)}`
  }, copied)
  const link = page.locator('[data-message-id="shared-room-link"][data-message-body]').getByRole('link', { name: copied, exact: true })
  await expect(link).toBeVisible()
  await link.click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${encodeURIComponent(ROOM)}$`))
  const highlighted = page.locator(`[data-message-id="${targetId}"].message-highlight`)
  await expect(highlighted).toBeInViewport()
  await expect(highlighted).toHaveCount(1)
  expect(page.context().pages()).toHaveLength(1)
})
