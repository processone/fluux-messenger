import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'
import { waitForActions } from './harness/messageInteraction'
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

/** A photo from Bob in the demo room; an empty body is what the receive parser leaves of a captionless one. */
async function seedRoomPhoto(page: Page, id: string, stanzaId: string, body: string) {
  await page.evaluate(async ({ roomJid, photo, id, stanzaId, body }) => {
    const scope = window as unknown as Scope
    await scope.__roomStore.getState().activateRoom(roomJid)
    scope.__demoClient.emitSDK('room:message', { roomJid, message: {
      type: 'groupchat', id, stanzaId, roomJid, from: `${roomJid}/Bob`, nick: 'Bob',
      body, attachment: photo, timestamp: new Date(), isOutgoing: false,
    }, incrementUnread: false } as never)
  }, { roomJid: ROOM, photo, id, stanzaId, body })
  await page.waitForFunction(({ roomJid, stanzaId }) => !!(window as unknown as Scope).__roomStore.getState().messages.get(roomJid)?.some(row => row.stanzaId === stanzaId), { roomJid: ROOM, stanzaId })
}

/** A received forward of that room message: the copy's claimed text, the link it generated, and the file it carries. */
function linkedForward(stanzaId: string, text: string, attachment: typeof photo) {
  const link = `xmpp:${ROOM}?join;msg=${stanzaId}`
  const fallback = `> Bob wrote:\n> ${text}\n${link}`
  const body = `Forward comment\n${fallback}`
  return {
    body,
    forwarded: { author: 'Bob', from: `${ROOM}/Bob`, type: 'groupchat', text, timestamp: Date.now(),
      fallback: { begin: 'Forward comment\n'.length, end: body.length, text: fallback } },
    references: [{ type: 'data', uri: link, begin: body.length - link.length, end: body.length }],
    attachment,
  }
}

test('the source label shares the name and time baseline, in a direct and a room copy', async ({ page }) => {
  await boot(page)
  for (const [id, forwarded] of [
    ['fwd-direct', { author: 'Emma Wilson', from: 'emma@fluux.chat', type: 'chat', text: 'Hello', timestamp: Date.now() - 86_400_000 }],
    ['fwd-room', { author: 'Bob', from: `${ROOM}/Bob`, type: 'groupchat', text: 'Hello', timestamp: Date.now() - 86_400_000 }],
  ] as const) {
    await receive(page, id, { forwarded })
    const header = copy(page, id).locator('.items-baseline').first()
    await expect(header).toBeVisible()
    // The text baseline of each part: the bottom of a zero-height inline marker placed right after the part's own text.
    const baselines = await header.evaluate(row => [...row.children].map(part => {
      const text = document.createTreeWalker(part, NodeFilter.SHOW_TEXT, { acceptNode: n => n.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP }).nextNode()!
      const marker = document.createElement('span')
      marker.style.cssText = 'display:inline-block;width:0;height:0'
      text.parentNode!.insertBefore(marker, text.nextSibling)
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
  // This copy's original is not in the demo history, so opening it shows a toast: that toast is the signal.
  const notFound = page.getByText('The original message is not in your history')
  await card.locator('img').click()
  // The click opens the image preview, which is the file, not the original.
  await expect(page.locator('[data-lightbox="image"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-lightbox="image"]')).toHaveCount(0)
  // A click on the card's own text opens the original; it proves the lookup runs, and that it ran once, not for the image click too.
  await card.getByText('Emma Wilson').click()
  await expect(notFound).toHaveCount(1)
  await page.waitForTimeout(500)
  await expect(notFound).toHaveCount(1)
})

test('a photo forwarded from a joined room stays in the verified quote with no differs flag', async ({ page }) => {
  await boot(page, `/rooms/${encodeURIComponent(ROOM)}`)
  const stanzaId = 'room-photo-stanza'
  await seedRoomPhoto(page, 'room-photo', stanzaId, 'Contacts view')
  await receive(page, 'fwd-room-photo', linkedForward(stanzaId, 'Contacts view', photo))
  const card = copy(page, 'fwd-room-photo')
  await expect(card).toContainText('Contacts view')
  await expect(card.locator('img')).toHaveCount(1)
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-room-photo-${test.info().project.name}`)
  await expect(card.locator('[data-forward-differs]')).toHaveCount(0)
})

test('an honest forward of a captionless room photo, sent and received for real, shows no differs flag', async ({ page }) => {
  await boot(page, `/rooms/${encodeURIComponent(ROOM)}`)
  await seedRoomPhoto(page, 'room-bare-photo', 'bare-photo-stanza', '')
  // The demo transport drops a chat stanza: keep the one the app builds, to deliver it back as a received message.
  await page.evaluate(() => {
    const scope = window as unknown as Scope & { __forward?: unknown }
    const transport = scope.__demoClient as unknown as { beginStanzaSend: (stanza: { name: string; getChild: (name: string, xmlns: string) => unknown }) => Promise<void> }
    const send = transport.beginStanzaSend.bind(transport)
    transport.beginStanzaSend = async stanza => {
      if (stanza.name === 'message' && stanza.getChild('forwarded', 'urn:xmpp:forward:0')) scope.__forward = stanza
      await send(stanza)
    }
  })
  const row = page.locator('[data-message-id="room-bare-photo"][data-message-body]')
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, 'room-bare-photo')
  await row.getByRole('button', { name: 'Forward message', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Forward message', exact: true })
  await picker.getByLabel('Chat or room').fill('emm')
  await picker.getByLabel('Chat or room').press('Enter')
  await picker.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(picker).toBeHidden()
  await page.waitForFunction(() => !!(window as unknown as { __forward?: unknown }).__forward)
  await page.evaluate(peer => {
    const scope = window as unknown as Scope & { __forward: { attrs: Record<string, string> } }
    const received = scope.__forward
    Object.assign(received.attrs, { from: `${peer}/phone`, to: 'you@fluux.chat/demo', id: 'fwd-bare-photo' })
    ;(scope.__demoClient.messages as unknown as { handle(stanza: unknown): void }).handle(received)
  }, PEER)
  await activateChat(page, PEER)
  const card = page.locator('[data-forwarded-copy]').last()
  await expect(card).toContainText('Bob')
  await expect(card.locator('img')).toHaveCount(1)
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-bare-photo-${test.info().project.name}`)
  await expect(card.locator('[data-forward-differs]')).toHaveCount(0)
  await expect(card.locator('> [data-forwarded-attachment] img')).toHaveCount(1)
})

test('a captionless room photo still flags a forward with other words or another file', async ({ page }) => {
  await boot(page, `/rooms/${encodeURIComponent(ROOM)}`)
  const stanzaId = 'flagged-photo-stanza'
  await seedRoomPhoto(page, 'room-flagged-photo', stanzaId, '')

  await receive(page, 'fwd-other-words', linkedForward(stanzaId, 'Send me your password', photo))
  const words = copy(page, 'fwd-other-words').locator('[data-forward-differs]')
  await expect(words).toContainText('Send me your password')
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-bare-other-words-${test.info().project.name}`)

  // The other file claims the room photo's name, so only its address tells them apart.
  const other = { ...photo, url: '/demo/screenshot-poll.png', name: 'poll.png' }
  await receive(page, 'fwd-other-file', linkedForward(stanzaId, photo.name, other))
  const card = copy(page, 'fwd-other-file')
  await expect(card.locator('[data-forward-differs] img[alt="poll.png"]')).toHaveCount(1)
  await expect(card.locator('img')).toHaveCount(1)
  await shot(page, `${process.env.FORWARD_TAG ?? 'after'}-bare-other-file-${test.info().project.name}`)
})
