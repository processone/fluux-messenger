import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'
import { ROOM_JID as ROOM } from '../apps/fluux/src/demo/constants'

// FLM-403: a received forwarded copy lines up its header (name, source label, time) on one text baseline,
// and the forwarded file is drawn inside the quote. The copy arrives as the forwarding message sends it:
// the quote data on the message and the file as that message's own attachment.
const PHOTO = '/demo/screenshot-contacts.png'
const photo = { url: PHOTO, name: 'contacts.png', mediaType: 'image/png', size: 80_000 }
const PEER = 'liam@fluux.chat'

type Scope = Window & { __demoClient: DemoClient; __roomStore: typeof roomStore }

async function boot(page: Page, hash = `/messages/${encodeURIComponent(PEER)}`) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#${hash}`)
  await page.evaluate(() => (window as unknown as Scope).__demoClient.stopAnimation())
}

async function receive(page: Page, id: string, message: Record<string, unknown>) {
  await page.evaluate(({ id, message, peer }) => {
    (window as unknown as Scope).__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id, conversationId: peer, from: peer, body: 'Forward comment', stanzaId: undefined, originId: undefined,
      timestamp: new Date(), isOutgoing: false, ...message,
    }, isLiveArrival: true } as never)
  }, { id, message, peer: PEER })
  await activateChat(page, PEER)
}

const shot = (page: Page, name: string) => page.screenshot({ path: process.env.FORWARD_EVIDENCE ? `${process.env.FORWARD_EVIDENCE}/${name}.png` : undefined })
const copy = (page: Page, id: string) => page.locator(`[data-message-id="${id}"] [data-forwarded-copy]`)

test('the source label shares the name and time baseline, in a direct and a room copy', async ({ page }) => {
  await boot(page)
  for (const [id, forwarded] of [
    ['fwd-direct', { author: 'Emma Wilson', from: 'emma@fluux.chat', type: 'chat', text: 'Hello', timestamp: Date.now() - 86_400_000 }],
    ['fwd-room', { author: 'Bob', from: `${ROOM}/Bob`, type: 'groupchat', text: 'Hello', timestamp: Date.now() - 86_400_000 }],
  ] as const) {
    await receive(page, id, { forwarded })
    const header = copy(page, id).locator('.items-baseline').first()
    await expect(header).toBeVisible()
    // The text baseline of each part: the bottom of a zero-height inline marker placed at the text's baseline.
    const baselines = await header.evaluate(row => [...row.children].map(part => {
      const marker = document.createElement('span')
      marker.style.cssText = 'display:inline-block;width:0;height:0'
      const textHost = [...part.querySelectorAll('*')].find(el => !el.children.length && el.textContent) ?? part
      textHost.appendChild(marker)
      const y = marker.getBoundingClientRect().bottom
      marker.remove()
      return y
    }))
    expect(baselines.length).toBe(3)
    await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-header-${id}-${test.info().project.name}`)
    expect(Math.max(...baselines) - Math.min(...baselines)).toBeLessThan(0.5)
  }
})

test('a forwarded photo is drawn inside the quote, once, and a click on it does not open the original', async ({ page }) => {
  await boot(page)
  await receive(page, 'fwd-photo', {
    forwarded: { author: 'Emma Wilson', from: 'emma@fluux.chat', type: 'chat', text: 'Contacts view', timestamp: Date.now() - 60_000 },
    attachment: photo,
  })
  const card = copy(page, 'fwd-photo')
  await expect(card.locator('img')).toHaveCount(1)
  await expect(page.locator('[data-message-id="fwd-photo"] img[alt="contacts.png"]')).toHaveCount(1)
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-photo-${test.info().project.name}`)
  await card.locator('img').click()
  await expect(page.getByText('Open the original message')).toHaveCount(0)
  await expect(page).toHaveURL(new RegExp(`/messages/${encodeURIComponent(PEER)}$`))
})

test('a photo forwarded from a joined room stays in the verified quote with no differs flag', async ({ page }) => {
  await boot(page, `/rooms/${encodeURIComponent(ROOM)}`)
  const stanzaId = 'room-photo-stanza'
  await page.evaluate(async ({ roomJid, photo, stanzaId }) => {
    const scope = window as unknown as Scope
    await scope.__roomStore.getState().activateRoom(roomJid)
    scope.__demoClient.emitSDK('room:message', { roomJid, message: {
      type: 'groupchat', id: 'room-photo', stanzaId, roomJid, from: `${roomJid}/Bob`, nick: 'Bob',
      body: 'Contacts view', attachment: photo, timestamp: new Date(), isOutgoing: false,
    }, incrementUnread: false } as never)
  }, { roomJid: ROOM, photo, stanzaId })
  await page.waitForFunction(({ roomJid, stanzaId }) => !!(window as unknown as Scope).__roomStore.getState().messages.get(roomJid)?.some(row => row.stanzaId === stanzaId), { roomJid: ROOM, stanzaId })
  const link = `xmpp:${ROOM}?join;msg=${stanzaId}`
  const fallback = `> Bob wrote:\n> Contacts view\n${link}`
  await receive(page, 'fwd-room-photo', {
    body: `Forward comment\n${fallback}`,
    forwarded: { author: 'Bob', from: `${ROOM}/Bob`, type: 'groupchat', text: 'Contacts view', timestamp: Date.now(),
      fallback: { begin: 'Forward comment\n'.length, end: `Forward comment\n${fallback}`.length, text: fallback } },
    references: [{ type: 'data', uri: link, begin: `Forward comment\n${fallback}`.length - link.length, end: `Forward comment\n${fallback}`.length }],
    attachment: photo,
  })
  const card = copy(page, 'fwd-room-photo')
  await expect(card).toContainText('Contacts view')
  await expect(card.locator('img')).toHaveCount(1)
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-room-photo-${test.info().project.name}`)
  await expect(card.locator('[data-forward-differs]')).toHaveCount(0)
})
