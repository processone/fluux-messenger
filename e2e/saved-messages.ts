import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { waitForActions } from './harness/messageInteraction'
import { activateChat } from './harness/scrollHarness'
import { ROOM_JID as ROOM } from '../apps/fluux/src/demo/constants'

// Saved messages: save a room message and a chat message from the More menu, see them in the
// Saved view, click through to the highlighted original, and remove them. Demo history is the
// fixture; the private-node transport has its own unit tests and live two-client check.
const PEER = 'emma@fluux.chat'

async function openMore(page: Page, id: string) {
  const row = page.locator(`[data-message-id="${id}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, id)
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  return row
}

test('save a room message and a chat message, open them from Saved, remove them', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  const roomId = 'demo-room-whisper-pub'
  const body = await page.evaluate(async ({ roomJid, roomId }) => {
    const scope = window as unknown as { __demoClient: DemoClient; __roomStore: typeof roomStore }
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    return scope.__roomStore.getState().messages.get(roomJid)!.find(row => row.id === roomId)!.body
  }, { roomJid: ROOM, roomId })

  // Save the room message.
  let row = await openMore(page, roomId)
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
  await expect(page.locator(`[data-message-id="${roomId}"]`).getByLabel('Saved', { exact: true }).first()).toBeVisible()

  // A chat message with an archive id, delivered live.
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'saved-chat-1', conversationId: peer, from: peer, body: 'The door code is on the board',
      stanzaId: 'archive-saved-chat-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
    location.hash = `#/messages/${encodeURIComponent(peer)}`
  }, PEER)
  row = await openMore(page, 'saved-chat-1')
  await row.getByRole('button', { name: 'Save message', exact: true }).click()

  // Both appear in Saved, newest saved first.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page).toHaveURL(/\/saved/)
  const rows = page.getByTestId('saved-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('The door code is on the board')
  await expect(rows.nth(1)).toContainText(body.slice(0, 20))

  // Open the room entry: its conversation opens with the original highlighted.
  await rows.nth(1).click()
  await expect(page).toHaveURL(new RegExp(`/rooms/${encodeURIComponent(ROOM)}$`))
  await expect(page.locator(`[data-message-id="${roomId}"].message-highlight`)).toBeInViewport()

  // Open the chat entry.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await page.getByTestId('saved-row').first().click()
  await expect(page).toHaveURL(new RegExp(`/messages/${encodeURIComponent(PEER)}$`))
  await expect(page.locator('[data-message-id="saved-chat-1"].message-highlight')).toBeInViewport()

  // Remove both from the list; the empty state says how to save one.
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).click()
  await expect(page.getByTestId('saved-row')).toHaveCount(1)
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).click()
  await expect(page.getByText('No saved messages')).toBeVisible()
  expect(page.context().pages()).toHaveLength(1)
})

test('a pending outgoing message offers no Save', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.stopAnimation()
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'pending-out', conversationId: peer, from: 'you@fluux.chat', body: 'sending…',
      stanzaId: undefined, originId: undefined, timestamp: new Date(), isOutgoing: true,
    }, isLiveArrival: true })
  }, PEER)
  const row = page.locator('[data-message-id="pending-out"][data-message-body]')
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await expect(row.getByRole('button', { name: 'Save message', exact: true })).toHaveCount(0)
})

test('pressing Enter on Remove removes the entry and does not open the original', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  await activateChat(page, PEER)
  await page.evaluate(peer => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.stopAnimation()
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id: 'saved-kb-1', conversationId: peer, from: peer, body: 'Keyboard removal check',
      stanzaId: 'archive-saved-kb-1', originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
  }, PEER)
  const row = await openMore(page, 'saved-kb-1')
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
  await page.getByRole('link', { name: 'Saved', exact: true }).or(page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(page).toHaveURL(/\/saved/)
  await page.getByTestId('saved-row').first().getByRole('button', { name: 'Remove from saved' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByText('No saved messages')).toBeVisible()
  await expect(page).toHaveURL(/\/saved/)
})
