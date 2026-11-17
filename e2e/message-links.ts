import { test, expect } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'
import { arrive, waitForActions } from './harness/messageInteraction'
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

// Approved preview piece: the reader builds the quote from its own room copy;
// an unjoined room discloses only its address and the deliberate Join action.
test('shared links show member quotes, deleted targets and non-member Join chips', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(ROOM)}`)
  const target = await page.evaluate(async roomJid => {
    const scope = window as unknown as { __demoClient: DemoClient; __roomStore: typeof roomStore }
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    const row = scope.__roomStore.getState().messages.get(roomJid)!.find(row => row.id === 'demo-room-whisper-pub')!
    return { id: row.id, stanzaId: row.stanzaId!, body: row.body, nick: row.nick }
  }, ROOM)
  await activateChat(page, 'emma@fluux.chat')
  const link = `xmpp:${ROOM}?join;msg=${encodeURIComponent(target.stanzaId)}`
  const outside = 'xmpp:engineering@conference.fluux.chat?join;msg=1731490000123456'
  await page.evaluate(({ link, outside }) => {
    const scope = window as unknown as { __demoClient: DemoClient }
    const peer = 'emma@fluux.chat'
    for (const [id, body, references] of [
      ['member-link', link, undefined],
      ['reference-link', 'See the room update', [{ type: 'data', uri: link }]],
      ['nonmember-link', outside, undefined],
    ] as const) scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id, body, references: references ? [...references] : undefined,
      conversationId: peer, from: peer, stanzaId: undefined, originId: undefined,
      timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
  }, { link, outside })
  const member = page.locator('[data-message-id="member-link"][data-message-body] [data-room-message-preview]')
  const reference = page.locator('[data-message-id="reference-link"][data-message-body] [data-room-message-preview]')
  const nonmember = page.locator('[data-message-id="nonmember-link"][data-message-body] [data-room-message-preview]')
  await expect(member).toContainText(target.body)
  await expect(member).toContainText(target.nick)
  await expect(reference).toContainText(target.body)
  await expect(nonmember).toContainText('Join the room to see it')
  await expect(nonmember).not.toContainText(target.body)
  await nonmember.getByRole('link').click()
  await expect(page.getByRole('button', { name: /Join room/ })).toBeVisible()
  expect(await page.evaluate(jid => (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState().rooms.get(jid)?.joined,
    'engineering@conference.fluux.chat')).toBe(false)
  await activateChat(page, 'emma@fluux.chat')
  await member.getByRole('link').click()
  await expect(page.locator(`[data-message-id="${target.id}"].message-highlight`)).toBeInViewport()
  expect(page.context().pages()).toHaveLength(1)
  await activateChat(page, 'emma@fluux.chat')
  await page.evaluate(({ roomJid, target }) => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.emitSDK('room:message-updated', { roomJid, messageId: target.id,
      updates: { isRetracted: true, body: '' } })
  }, { roomJid: ROOM, target })
  await expect(member).toContainText('Message deleted')
  await expect(reference).not.toContainText(target.body)
})

test.describe('mobile message links', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('releasing the opening touch leaves Copy message link ready for a deliberate tap', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Browser-native held touch requires Chromium input dispatch; geometry is covered in both engines.')
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
    const content = row.locator('[class~="touch:select-none"]').first()
    // A low message forces the portal upward, potentially beneath the finger.
    await content.evaluate(element => {
      const list = element.closest('[data-message-list]')!
      const box = element.getBoundingClientRect()
      list.scrollTop += box.y + box.height / 2 - (list.getBoundingClientRect().bottom - 22)
    })
    const box = (await content.boundingBox())!
    const touch = await page.context().newCDPSession(page)
    const sheet = page.getByRole('dialog', { name: 'More options', exact: true })
    try {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
      await expect(sheet).toBeVisible()
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
      await expect(sheet).toBeVisible()
      expect(copied).toBe('')
      await sheet.getByRole('button', { name: 'Copy message link', exact: true }).tap()
      await expect.poll(() => copied).toBe(`xmpp:${ROOM}?join;msg=${encodeURIComponent(stanzaId)}`)
      await expect(sheet).toBeHidden()
    } finally {
      await touch.detach()
    }
  })
})

// Forward sends one ordinary message: comment, attributed quote and room link, with the
// quote and link marked as XEP-0428 fallback and never an XEP-0297 copy. Exercise the actual demo SDK serializer and observe its local
// transport boundary; no external account receives these messages.
async function prepareForward(page: import('@playwright/test').Page) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false&virt=1#/rooms/${encodeURIComponent(ROOM)}`)
  return page.evaluate(async roomJid => {
    type Stanza = { name: string; getChildText: (name: string) => string; toString: () => string }
    const scope = window as unknown as {
      __demoClient: DemoClient; __roomStore: typeof roomStore; __forwardStanzas: string[]
    }
    scope.__demoClient.stopAnimation()
    await scope.__roomStore.getState().activateRoom(roomJid)
    const row = scope.__roomStore.getState().messages.get(roomJid)!.find(row => row.id === 'demo-room-whisper-pub')!
    const transport = scope.__demoClient as unknown as { beginStanzaSend: (stanza: Stanza) => Promise<void> }
    const original = transport.beginStanzaSend.bind(transport)
    scope.__forwardStanzas = []
    transport.beginStanzaSend = async stanza => {
      if (stanza.name === 'message' && stanza.getChildText('body')) scope.__forwardStanzas.push(stanza.toString())
      await original(stanza)
    }
    return { id: row.id, body: row.body, nick: row.nick, stanzaId: row.stanzaId! }
  }, ROOM)
}

const FORWARD_QUOTE = 'urn:fluux:forward-quote:0'
const quoteOf = (target: { nick: string; body: string }) => `> ${target.nick} wrote:\n${target.body.split('\n').map(line => `> ${line}`).join('\n')}\n`

async function assertForwardStanza(page: import('@playwright/test').Page, to: string, type: string, body: string, link: string, fallbackText: string) {
  const stanzas = await page.evaluate(() => (window as unknown as { __forwardStanzas: string[] }).__forwardStanzas)
  expect(stanzas).toHaveLength(1)
  const parsed = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const ref = doc.getElementsByTagNameNS('urn:xmpp:reference:0', 'reference')[0]
    return {
      to: doc.documentElement.getAttribute('to'), type: doc.documentElement.getAttribute('type'),
      body: doc.getElementsByTagName('body')[0]?.textContent,
      reference: ref ? { type: ref.getAttribute('type'), uri: ref.getAttribute('uri') } : undefined,
      forwardedCopies: doc.getElementsByTagNameNS('urn:xmpp:forward:0', 'forwarded').length,
      fallback: Array.from(doc.getElementsByTagNameNS('urn:xmpp:fallback:0', 'fallback')).map(el => ({
        for: el.getAttribute('for'), range: el.getElementsByTagNameNS('urn:xmpp:fallback:0', 'body')[0]?.getAttributeNames().map(name => [name, el.getElementsByTagNameNS('urn:xmpp:fallback:0', 'body')[0].getAttribute(name)]),
      })),
    }
  }, stanzas[0])
  const marker = parsed.fallback.find(item => item.for === FORWARD_QUOTE)
  const range = Object.fromEntries(marker?.range ?? []) as { start: string; end: string }
  // The marker covers exactly the generated quote and link, in code points, never the comment.
  expect(Array.from(body).slice(Number(range.start), Number(range.end)).join('')).toBe(fallbackText)
  expect({ ...parsed, fallback: undefined }).toEqual({ to, type, body, reference: { type: 'data', uri: link }, forwardedCopies: 0, fallback: undefined })
  await test.info().attach('outgoing-stanza', { body: stanzas[0], contentType: 'application/xml' })
  if (process.env.FLUUX_FORWARD_EVIDENCE) {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(`${process.env.FLUUX_FORWARD_EVIDENCE}/${type}-stanza.xml`, stanzas[0])
  }
}

async function forwardPicture(page: import('@playwright/test').Page, name: string) {
  if (process.env.FLUUX_FORWARD_EVIDENCE) {
    const engine = test.info().project.name.split('-').at(-1)
    await page.screenshot({ path: `${process.env.FLUUX_FORWARD_EVIDENCE}/${name}-${engine}.png`, animations: 'disabled', scale: 'css' })
  }
}

test('Forward sends a room link with an optional comment to a chosen contact', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const target = await prepareForward(page)
  const link = `xmpp:${ROOM}?join;msg=${encodeURIComponent(target.stanzaId)}`
  const row = page.locator(`[data-message-id="${target.id}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, target.id)
  await forwardPicture(page, 'after-desktop')
  await row.getByRole('button', { name: 'Forward message', exact: true }).click()
  const picker = page.getByRole('dialog', { name: 'Forward message', exact: true })
  await expect(picker.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  // The destination is the shared type-to-filter picker: it opens focused, typing
  // narrows its list, and Enter picks the highlighted entry.
  const destination = picker.getByLabel('Chat or room')
  const choices = page.getByTestId('contact-suggestions').getByRole('button')
  await expect(destination).toBeFocused()
  await expect(choices.filter({ hasText: 'Team Chat' })).toHaveCount(1)
  expect(await choices.count()).toBeGreaterThan(1)
  await forwardPicture(page, 'after-picker-open')
  await destination.fill('stranger@example.org')
  await expect(page.getByTestId('contact-suggestions')).toHaveText('No contacts found')
  await destination.press('Enter')
  await expect(picker.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await forwardPicture(page, 'after-picker-no-match')
  await destination.fill('emm')
  await expect(choices).toHaveCount(1)
  await expect(choices).toContainText('Emma Wilson')
  await forwardPicture(page, 'after-picker-filtered')
  await destination.press('Enter')
  await expect(picker.getByLabel('Comment (optional)')).toBeFocused()
  await expect(picker.getByText('Emma Wilson', { exact: true })).toBeVisible()
  await picker.getByLabel('Comment (optional)').fill('Please review')
  await expect(page.locator('[data-message-list]')).not.toHaveAttribute('data-message-interaction', target.id)
  await arrive(page, 'room', Array.from({ length: 80 }, (_, index) => `forward-arrival-${index}`))
  await expect(row).toHaveCount(0)
  await expect(picker.getByText('Emma Wilson', { exact: true })).toBeVisible()
  await expect(picker.getByLabel('Comment (optional)')).toHaveValue('Please review')
  await forwardPicture(page, 'after-picker')
  await picker.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(picker).toBeHidden()
  await assertForwardStanza(page, 'emma@fluux.chat', 'chat', `Please review\n${quoteOf(target)}${link}`, link, `${quoteOf(target)}${link}`)
  await activateChat(page, 'emma@fluux.chat')
  const sent = page.locator('[data-message-body]').filter({ hasText: 'Please review' }).last()
  await expect(sent).toBeVisible()
  // The source is readable, so the preview replaces the quote and link.
  await expect(sent.locator('[data-room-message-preview]')).toContainText(target.body)
  await expect(sent).not.toContainText('wrote:')
  await expect(sent.getByRole('link', { name: link, exact: true })).toHaveCount(0)
  await forwardPicture(page, 'after-recipient')
  // Losing access to the source restores the labelled quote and link; regaining it hides them again.
  const setJoined = (joined: boolean) => page.evaluate(({ jid, joined }) =>
    (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState().updateRoom(jid, { joined }), { jid: ROOM, joined })
  await setJoined(false)
  await expect(sent).toContainText('wrote:')
  await expect(sent).toContainText('Quoted copy from a forwarded message')
  await expect(sent.getByRole('link', { name: link, exact: true }).first()).toBeVisible()
  await expect(sent.locator('[data-room-message-preview]')).toContainText('Join the room to see it')
  await forwardPicture(page, 'after-recipient-no-access')
  await setJoined(true)
  await expect(sent).not.toContainText('wrote:')
  await expect(sent.locator('[data-room-message-preview]')).toContainText(target.body)
  await sent.locator('[data-room-message-preview]').getByRole('link').click()
  await expect(page.locator(`[data-message-id="${target.id}"].message-highlight`)).toBeInViewport()
  await forwardPicture(page, 'after-jump')
})

test.describe('touch forwarding', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  test('Forward opens from the action sheet, cancels without sending and shares to a joined room', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Held touch uses Chromium input dispatch; the shared picker runs in both engines above.')
    const target = await prepareForward(page)
    // Whispers remain outside the link-sharing action boundary.
    const whisper = page.locator('[data-message-id="demo-room-whisper-out"][data-message-body]')
    await expect(whisper).toHaveCount(1)
    await expect(whisper.getByRole('button', { name: 'Forward message', exact: true })).toHaveCount(0)
    const link = `xmpp:${ROOM}?join;msg=${encodeURIComponent(target.stanzaId)}`
    const row = page.locator(`[data-message-id="${target.id}"][data-message-body]`)
    const open = async () => {
      await row.scrollIntoViewIfNeeded()
      const box = (await row.locator('[class~="touch:select-none"]').first().boundingBox())!
      const touch = await page.context().newCDPSession(page)
      try {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
        const sheet = page.getByRole('dialog', { name: 'More options', exact: true })
        await expect(sheet).toBeVisible()
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
        await expect(sheet.getByRole('button', { name: 'Forward message', exact: true })).toBeVisible()
        await forwardPicture(page, 'after-touch')
        await sheet.getByRole('button', { name: 'Forward message', exact: true }).tap()
      } finally { await touch.detach() }
    }
    await open()
    const picker = page.getByRole('dialog', { name: 'Forward message', exact: true })
    await picker.getByRole('button', { name: 'Cancel', exact: true }).tap()
    await expect(picker).toBeHidden()
    expect(await page.evaluate(() => (window as unknown as { __forwardStanzas: string[] }).__forwardStanzas)).toHaveLength(0)
    await open()
    await picker.getByLabel('Chat or room').fill('team')
    await forwardPicture(page, 'after-touch-filtered')
    await page.getByTestId('contact-suggestions').getByRole('button', { name: /Team Chat/ }).tap()
    await expect(picker.getByText('Team Chat', { exact: true })).toBeVisible()
    await arrive(page, 'room', Array.from({ length: 80 }, (_, index) => `forward-touch-arrival-${index}`))
    await expect(row).toHaveCount(0)
    await expect(picker.getByText('Team Chat', { exact: true })).toBeVisible()
    await forwardPicture(page, 'after-touch-picker')
    await picker.getByRole('button', { name: 'Send', exact: true }).tap()
    await expect(picker).toBeHidden()
    await assertForwardStanza(page, ROOM, 'groupchat', `${quoteOf(target)}${link}`, link, `${quoteOf(target)}${link}`)
    const sent = page.locator('[data-message-body]').filter({ has: page.locator('[data-room-message-preview]') }).last()
    await expect(sent.locator('[data-room-message-preview]')).toContainText(target.body)
    await expect(sent).not.toContainText('wrote:')
    await forwardPicture(page, 'after-room-recipient')
  })
})
