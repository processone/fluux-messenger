import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
// @ts-expect-error @xmpp/client has no published declarations.
import { client as xmppClient, xml } from '@xmpp/client'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Intent: issue #1453's approved room-only contract. Two actual application
// sessions, actual server discovery, reflected identities and archived markers.
// The control peers provision only this disposable server; they never simulate
// an app's read, focus, opt-out or nick-change action.
//
// FLUUX_LIVE_APP=http://localhost:5173 FLUUX_LIVE_ACCOUNTS=/path/accounts.json \
// FLUUX_LIVE_EVIDENCE=/path/evidence npx playwright test --config e2e/playwright.room-read-live.config.ts
// accounts.json uses the saved-messages.live.ts setup: { ws, users: { alice, bob } }.
// FLUUX_ROOM_READ_BEFORE=1 captures only the unchanged base application's views.
const accountsFile = process.env.FLUUX_LIVE_ACCOUNTS
const evidence = process.env.FLUUX_LIVE_EVIDENCE
const videoDir = process.env.FLUUX_LIVE_VIDEO
const before = process.env.FLUUX_ROOM_READ_BEFORE === '1'
const config = accountsFile ? JSON.parse(readFileSync(accountsFile, 'utf8')) as {
  ws: string; users: Record<'alice' | 'bob', { jid: string; password: string }>
} : undefined
const local = new Set(['localhost', '127.0.0.1', '[::1]'])
if (config) {
  if (!local.has(new URL(config.ws).hostname) || !process.env.FLUUX_LIVE_APP || !local.has(new URL(process.env.FLUUX_LIVE_APP).hostname)) throw new Error('Room proof requires loopback app and server')
  for (const name of ['alice', 'bob'] as const) if (config.users[name]?.jid !== `${name}@localhost`) throw new Error('Room proof refuses non-disposable accounts')
}
test.skip(!config, 'FLUUX_LIVE_ACCOUNTS is not set')
const MUC = 'http://jabber.org/protocol/muc'
const OWNER = `${MUC}#owner`
const ADMIN = `${MUC}#admin`
const DATA = 'jabber:x:data'
const MARKERS = 'urn:xmpp:chat-markers:0'
const BOOKMARKS = 'urn:xmpp:bookmarks:1'
const PUBSUB = 'http://jabber.org/protocol/pubsub'
const DISCO = 'http://jabber.org/protocol/disco#info'
const title = 'Read marker proof'
const publicTitle = 'Public room proof'
const otherTitle = 'Other private room proof'
const content = ['Room reading proof: first message', 'Room reading proof: focused advance', 'Room reading proof: sharing stopped']
interface App { page: Page; context: BrowserContext; sent: string[]; received: string[]; name: string; started: number; marks: Record<string, number>; sentObservers: Set<() => void>; quietChecks: { name: string; count: number; durationMs: number }[] }
const mark = (client: App, name: string) => { client.marks[name] = (Date.now() - client.started) / 1000 }
const displayed = (app: App) => app.sent.filter(frame => /^<message\b/.test(frame) && frame.includes(MARKERS) && /type=['"]groupchat['"]/.test(frame))
/** Observe a finite real-stream window; this is a negative check, not a retry. */
async function noPublication(client: App, count: number, name: string) {
  expect(displayed(client)).toHaveLength(count)
  let timer: ReturnType<typeof setTimeout> | undefined
  let observed!: () => void
  const started = Date.now()
  try {
    await new Promise<void>((resolve, reject) => {
      observed = () => { if (displayed(client).length !== count) reject(new Error(`Unexpected room publication during ${name}`)) }
      client.sentObservers.add(observed)
      timer = setTimeout(resolve, 650)
    })
    expect(displayed(client)).toHaveLength(count)
    client.quietChecks.push({ name, count, durationMs: Date.now() - started })
  } finally { clearTimeout(timer); client.sentObservers.delete(observed) }
}
const shot = async (page: Page, name: string) => {
  if (!evidence) return
  await page.mouse.move(1270, 790)
  await page.screenshot({ path: `${evidence}/room-read-${before ? 'before' : 'after'}-${name}.png` })
}
async function app(browser: Browser, name: 'alice' | 'bob', touch = false): Promise<App> {
  if (videoDir) mkdirSync(videoDir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}) })
  const started = Date.now()
  const page = await context.newPage()
  const sent: string[] = [], received: string[] = []
  const sentObservers = new Set<() => void>()
  page.on('websocket', socket => {
    socket.on('framesent', frame => { if (typeof frame.payload === 'string') { sent.push(frame.payload); for (const observe of sentObservers) observe() } })
    socket.on('framereceived', frame => { if (typeof frame.payload === 'string') received.push(frame.payload) })
  })
  await page.addInitScript(() => { localStorage.setItem('i18nextLng', 'en'); localStorage.setItem('fluux-theme', 'dark') })
  await page.goto('/')
  await page.locator('#jid').fill(config!.users[name].jid)
  await page.locator('input[type=password]').first().fill(config!.users[name].password)
  await page.keyboard.press('Control+,')
  await page.locator('#server').fill(config!.ws)
  await page.getByText('Remember me').click()
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  return { page, context, sent, received, name, started, marks: {}, sentObservers, quietChecks: [] }
}
async function peer(name: 'alice' | 'bob') {
  const client = xmppClient({ service: config!.ws, domain: 'localhost', username: name,
    password: config!.users[name].password, resource: `room-proof-${randomUUID()}` })
  client.on('error', () => {})
  await client.start()
  return client
}
async function joinControl(client: Awaited<ReturnType<typeof peer>>, jid: string) {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.off('stanza', handler); reject(new Error('Control room join did not complete')) }, 15_000)
    const handler = (stanza: ReturnType<typeof xml>) => {
      if (stanza.attrs.from !== `${jid}/Setup` || !stanza.is('presence')) return
      if (stanza.attrs.type === 'error') { clearTimeout(timer); client.off('stanza', handler); reject(new Error('Control room join refused')); return }
      if (!stanza.getChild('x', `${MUC}#user`)?.getChildren('status').some((status: ReturnType<typeof xml>) => status.attrs.code === '110')) return
      clearTimeout(timer); client.off('stanza', handler); resolve()
    }
    client.on('stanza', handler)
    void client.send(xml('presence', { to: `${jid}/Setup` }, xml('x', { xmlns: MUC }))).catch(reject)
  })
}
async function bookmark(client: Awaited<ReturnType<typeof peer>>, room: string, name: string, nick: string, remove = false) {
  const field = (key: string, value: string) => xml('field', { var: key }, xml('value', {}, value))
  await client.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    remove ? xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room }))
      : xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name, autojoin: 'true' }, xml('nick', {}, nick)))),
    ...(!remove ? [xml('publish-options', {}, xml('x', { xmlns: DATA, type: 'submit' },
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, `${PUBSUB}#publish-options`)),
      field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', 'max'), field('pubsub#send_last_published_item', 'never')))] : []))))
}
async function provision(owner: Awaited<ReturnType<typeof peer>>, room: string, name: string, listed: boolean) {
  await joinControl(owner, room)
  const form = await owner.iqCaller.request(xml('iq', { type: 'get', to: room }, xml('query', { xmlns: OWNER })))
  const fields = form.getChild('query', OWNER)?.getChild('x', DATA)?.getChildren('field') ?? []
  const values: Record<string, string> = {
    'muc#roomconfig_roomname': name, 'muc#roomconfig_persistentroom': '1', 'muc#roomconfig_publicroom': listed ? '1' : '0',
    'muc#roomconfig_membersonly': '1', 'muc#roomconfig_whois': 'anyone', 'mam': '1',
  }
  for (const key of Object.keys(values)) if (!fields.some((field: ReturnType<typeof xml>) => field.attrs.var === key)) throw new Error(`Lab room configuration lacks ${key}`)
  await owner.iqCaller.request(xml('iq', { type: 'set', to: room }, xml('query', { xmlns: OWNER },
    xml('x', { xmlns: DATA, type: 'submit' },
      xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, `${MUC}#roomconfig`)), ...Object.entries(values).map(([key, value]) => xml('field', { var: key }, xml('value', {}, value)))))))
  await owner.iqCaller.request(xml('iq', { type: 'set', to: room }, xml('query', { xmlns: ADMIN },
    xml('item', { jid: 'bob@localhost', affiliation: 'member' }))))
  await owner.send(xml('presence', { type: 'unavailable', to: `${room}/Setup` }))
}
async function openRoom(client: App, name = title) {
  await client.page.getByRole('button', { name: 'Rooms', exact: true }).first().click()
  await client.page.getByRole('complementary').getByText(name, { exact: true }).first().click()
  const join = client.page.getByRole('button', { name: 'Join room to participate', exact: true })
  if (await join.isVisible()) {
    await join.click()
    const confirm = client.page.getByRole('button', { name: 'Join anyway', exact: true })
    if (await confirm.isVisible()) await confirm.click()
  }
  await expect(client.page.getByRole('combobox', { name: /^Message / })).toBeVisible({ timeout: 30_000 })
}
async function privacy(client: App) {
  await client.page.getByRole('button', { name: 'Settings', exact: true }).click()
  await client.page.getByRole('button', { name: 'Privacy', exact: true }).click()
}
async function roomConsent(client: App, enabled: boolean, captureName = enabled ? 'room-details' : 'room-details-disabled') {
  await client.page.getByTestId('room-info-area').getByRole('button').click()
  const control = client.page.getByRole('switch', { name: 'Share my read position in this room', exact: true })
  await expect(control).toHaveAttribute('aria-checked', String(!enabled))
  await control.click()
  await expect(control).toHaveAttribute('aria-checked', String(enabled))
  await shot(client.page, captureName)
  await client.page.keyboard.press('Escape')
}
async function say(client: App, body: string) {
  const composer = client.page.getByRole('combobox', { name: /^Message / })
  await composer.fill(body); await composer.press('Enter')
  await expect(client.page.locator('[data-message-body]').filter({ hasText: body })).toBeVisible()
}

test('two real clients share only opted-in focused reading, keep identity and replay the archive', async ({ browser }) => {
  if (evidence) mkdirSync(evidence, { recursive: true })
  const owner = await peer('alice'), member = await peer('bob')
  const room = `read-${randomUUID().slice(0, 8)}@conference.localhost`
  const publicRoom = `public-${randomUUID().slice(0, 8)}@conference.localhost`
  const otherRoom = `other-${randomUUID().slice(0, 8)}@conference.localhost`
  const clients: App[] = []
  try {
    await provision(owner, room, title, false)
    await provision(owner, publicRoom, publicTitle, true)
    await provision(owner, otherRoom, otherTitle, false)
    for (const [client, nick] of [[owner, 'Alice'], [member, 'Bob']] as const) {
      await bookmark(client, room, title, nick); await bookmark(client, publicRoom, publicTitle, nick); await bookmark(client, otherRoom, otherTitle, nick)
    }
    const alice = await app(browser, 'alice'); clients.push(alice)
    const bob = await app(browser, 'bob', true); clients.push(bob)
    await openRoom(alice); await openRoom(bob)
    await say(bob, content[0])
    if (before) mark(bob, 'reading-focus')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: content[0] })).toBeInViewport()
    await noPublication(alice, 0, 'default-off')
    await bob.page.bringToFront()
    await shot(bob.page, 'timeline')
    if (before) {
      await bob.page.setViewportSize({ width: 390, height: 800 })
      await shot(bob.page, 'phone-timeline')
      await bob.page.setViewportSize({ width: 1280, height: 800 })
    }
    await alice.page.bringToFront()
    await privacy(alice)
    if (before) {
      await expect(alice.page.getByRole('switch', { name: 'Share room read positions', exact: true })).toHaveCount(0)
      await shot(alice.page, 'privacy')
      await openRoom(alice)
      await alice.page.getByTestId('room-info-area').getByRole('button').click()
      await shot(alice.page, 'room-details')
      return
    }
    const master = alice.page.getByRole('switch', { name: 'Share room read positions', exact: true })
    await expect(master).toHaveAttribute('aria-checked', 'false')
    await master.click()
    await shot(alice.page, 'privacy')
    await openRoom(alice)
    await roomConsent(alice, true)
    // Real focus recovery produces measured viewport evidence, not a read-store event.
    const blank = await alice.context.newPage(); await blank.goto('about:blank')
    mark(bob, 'reading-focus')
    await alice.page.bringToFront(); await blank.close()
    await expect.poll(() => displayed(alice).length).toBe(1)
    await bob.page.bringToFront()
    const readerButton = bob.page.getByRole('button', { name: 'Read through this message: Alice', exact: true })
    await expect(readerButton).toBeVisible()
    // Keyboard activation opens the full named list; Escape returns to its opener.
    await readerButton.focus(); await readerButton.press('Enter')
    await expect(bob.page.getByRole('dialog', { name: 'Read through this message' }).getByText('Alice', { exact: true })).toBeVisible()
    await shot(bob.page, 'readers')
    await bob.page.keyboard.press('Escape')
    await expect(readerButton).toBeFocused()
    await readerButton.tap()
    await expect(bob.page.getByRole('dialog', { name: 'Read through this message' })).toBeVisible()
    await bob.page.keyboard.press('Escape')
    await shot(bob.page, 'timeline')
    await bob.page.setViewportSize({ width: 390, height: 800 })
    await shot(bob.page, 'phone-timeline')
    await bob.page.setViewportSize({ width: 1280, height: 800 })

    // A focused window is not viewing while a dialog covers the timeline.
    await alice.page.bringToFront()
    await alice.page.getByTestId('room-info-area').getByRole('button').click()
    await expect(alice.page.locator('[data-modal="true"]')).toBeVisible()
    const modalHeld = displayed(alice).length
    await bob.page.bringToFront(); await say(bob, 'A dialog covers this new message')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'A dialog covers this new message' })).toHaveCount(1)
    await noPublication(alice, modalHeld, 'open-dialog')
    await shot(alice.page, 'covered-dialog')
    await alice.page.keyboard.press('Escape')
    const modalRecovery = await alice.context.newPage(); await modalRecovery.goto('about:blank')
    await alice.page.bringToFront(); await modalRecovery.close()
    await expect.poll(() => displayed(alice).length).toBe(modalHeld + 1)

    // The phone members pane makes the conversation inert, not a modal.
    await alice.page.setViewportSize({ width: 390, height: 800 })
    await alice.page.getByRole('button', { name: 'Show members', exact: true }).click()
    await expect.poll(() => alice.page.locator('.message-input[contenteditable="true"]').evaluate(element => !!element.closest('[inert]'))).toBe(true)
    const paneHeld = displayed(alice).length
    await bob.page.bringToFront(); await say(bob, 'The members pane covers this new message')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'The members pane covers this new message' })).toHaveCount(1)
    await noPublication(alice, paneHeld, 'covered-phone-members')
    await shot(alice.page, 'covered-phone-members')
    await alice.page.getByRole('heading', { name: 'Members', exact: true }).locator('..').getByRole('button').click()
    await expect.poll(() => alice.page.locator('.message-input[contenteditable="true"]').evaluate(element => !!element.closest('[inert]'))).toBe(false)
    await alice.page.setViewportSize({ width: 1280, height: 800 })
    const paneRecovery = await alice.context.newPage(); await paneRecovery.goto('about:blank')
    await alice.page.bringToFront(); await paneRecovery.close()
    await expect.poll(() => displayed(alice).length).toBe(paneHeld + 1)

    const hidden = await alice.context.newPage(); await hidden.goto('about:blank')
    await expect.poll(() => alice.page.evaluate(() => document.visibilityState)).toBe('hidden')
    const held = displayed(alice).length
    await say(bob, content[1])
    await expect.poll(() => alice.received.some(frame => frame.includes(content[1]))).toBe(true)
    await noPublication(alice, held, 'background-window')
    await alice.page.bringToFront(); await hidden.close()
    await expect.poll(() => displayed(alice).length).toBe(held + 1)
    await roomConsent(alice, false)
    const stopped = displayed(alice).length
    await bob.page.bringToFront(); await say(bob, content[2])
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: content[2] })).toBeInViewport()
    await noPublication(alice, stopped, 'room-opt-out')

    // The actual app's slash command changes this session's nick.
    const composer = alice.page.getByRole('combobox', { name: /^Message / })
    await composer.fill('/nick AliceRenamed'); await composer.press('Enter')
    await bob.page.bringToFront()
    await expect(bob.page.getByRole('button', { name: 'Read through this message: AliceRenamed', exact: true })).toBeVisible()
    await shot(bob.page, 'nick-change')

    // A fresh stream (not a simulated receiver call) replays archived markers.
    await bob.page.evaluate(() => sessionStorage.clear())
    await bob.page.reload()
    await openRoom(bob)
    await expect(bob.page.getByRole('button', { name: 'Read through this message: AliceRenamed', exact: true })).toBeVisible({ timeout: 30_000 })
    await noPublication(bob, 0, 'replay-without-consent')
    await shot(bob.page, 'archive-replay')

    // Even explicit room consent cannot override a positive public-listing flag.
    await openRoom(alice, publicTitle)
    await roomConsent(alice, true, 'public-room-details')
    await openRoom(bob, publicTitle)
    const publicBefore = displayed(alice).length
    await say(bob, 'Public room reading must stay private')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'Public room reading must stay private' })).toBeInViewport()
    await noPublication(alice, publicBefore, 'public-room')
    // Choosing one eligible room must not enable another eligible room.
    await openRoom(alice, otherTitle); await openRoom(bob, otherTitle)
    const otherBefore = displayed(alice).length
    await say(bob, 'This private room was not chosen')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'This private room was not chosen' })).toBeInViewport()
    await noPublication(alice, otherBefore, 'unchosen-room')
    await alice.page.getByTestId('room-info-area').getByRole('button').click()
    await expect(alice.page.getByRole('switch', { name: 'Share my read position in this room', exact: true })).toHaveAttribute('aria-checked', 'false')
    await alice.page.keyboard.press('Escape')

    // The master switch also stops a room whose own choice remains enabled.
    await openRoom(alice); await roomConsent(alice, true, 'room-details-reenabled')
    await privacy(alice)
    await alice.page.getByRole('switch', { name: 'Share room read positions', exact: true }).click()
    await openRoom(alice); await openRoom(bob)
    const masterStopped = displayed(alice).length
    await say(bob, 'The master switch stops every chosen room')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'The master switch stops every chosen room' })).toBeInViewport()
    await noPublication(alice, masterStopped, 'master-opt-out')
    const disco = await owner.iqCaller.request(xml('iq', { type: 'get', to: room }, xml('query', { xmlns: DISCO })))
    const publicDisco = await owner.iqCaller.request(xml('iq', { type: 'get', to: publicRoom }, xml('query', { xmlns: DISCO })))
    if (evidence) {
      writeFileSync(`${evidence}/room-read-protocol-fixtures.json`, JSON.stringify({
        eligibleRoom: disco.toString(), publicRoom: publicDisco.toString(),
        quietChecks: clients.map(client => ({ client: client.name, checks: client.quietChecks })),
        sentMarkers: displayed(alice), reflectedMarkers: bob.received.filter(frame => frame.includes(MARKERS) && /type=['"]groupchat['"]/.test(frame)),
      }, null, 2))
    }
  } finally {
    for (const client of clients) {
      await client.context.close()
      if (videoDir && client.page.video()) {
        const path = await client.page.video()!.path()
        writeFileSync(`${videoDir}/${before ? 'before' : 'after'}-${client.name}-clip.json`, JSON.stringify({ path, marks: client.marks }, null, 2))
      }
    }
    for (const roomJid of [room, publicRoom, otherRoom]) {
      await Promise.allSettled([bookmark(owner, roomJid, '', '', true), bookmark(member, roomJid, '', '', true),
        owner.iqCaller.request(xml('iq', { type: 'set', to: roomJid }, xml('query', { xmlns: OWNER }, xml('destroy'))))])
    }
    await owner.stop().catch(() => {}); await member.stop().catch(() => {})
  }
})
