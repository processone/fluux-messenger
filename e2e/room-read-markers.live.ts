import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { generateKey, createMessage, encrypt } from 'openpgp'
// @ts-expect-error @xmpp/client has no published declarations.
import { client as xmppClient, xml } from '@xmpp/client'
import { test, expect, type Browser, type BrowserContext, type ConsoleMessage, type Page } from '@playwright/test'

// Intent: issue #1453's approved room-only contract. Two actual application
// sessions, actual server discovery, reflected identities and archived markers.
// Control peers supply room setup, encrypted packets, private sync and occupant
// sessions. The app still owns viewing, focus, opt-out and nickname changes.
//
// FLUUX_LIVE_APP=http://localhost:5173 FLUUX_LIVE_ACCOUNTS=/path/accounts.json \
// FLUUX_LIVE_EVIDENCE=/path/evidence npx playwright test --config e2e/playwright.room-read-live.config.ts
// accounts.json uses the saved-messages.live.ts setup: { ws, users: { alice, bob } }.
// FLUUX_ROOM_READ_BEFORE=1 captures only the unchanged base application's views.
const accountsFile = process.env.FLUUX_LIVE_ACCOUNTS
const evidence = process.env.FLUUX_LIVE_EVIDENCE
const videoDir = process.env.FLUUX_LIVE_VIDEO
const before = process.env.FLUUX_ROOM_READ_BEFORE === '1'
// Pin only disposable room names for serial, matched Before/After captures.
const fixtureId = process.env.FLUUX_ROOM_READ_FIXTURE_ID
if (fixtureId && !/^[a-f0-9]{8}$/.test(fixtureId)) throw new Error('Room fixture ID must contain eight lowercase hexadecimal characters')
const roomId = () => fixtureId ?? randomUUID().slice(0, 8)
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
  // Keep the recording at real speed, but photograph the completed view rather
  // than an opening dialog's first translucent frame. Ignore infinite pulses.
  await page.evaluate(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    await Promise.all(document.getAnimations()
      .filter(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().iterations))
      .map(animation => animation.finished.catch(() => {})))
  })
  await page.screenshot({ path: `${evidence}/room-read-${before ? 'before' : 'after'}-${name}.png` })
}
async function app(browser: Browser, name: 'alice' | 'bob', touch = false): Promise<App> {
  if (videoDir) mkdirSync(videoDir, { recursive: true })
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: touch,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } } } : {}) })
  const started = Date.now()
  const page = await context.newPage()
  const startupError = (error: Error) => console.error('Live app startup error:', error.message)
  const startupConsole = (message: ConsoleMessage) => { if (message.type() === 'error') console.error('Live app startup console error:', message.text()) }
  page.on('pageerror', startupError)
  page.on('console', startupConsole)
  const sent: string[] = [], received: string[] = []
  const sentObservers = new Set<() => void>()
  page.on('websocket', socket => {
    socket.on('framesent', frame => { if (typeof frame.payload === 'string') { sent.push(frame.payload); for (const observe of sentObservers) observe() } })
    socket.on('framereceived', frame => { if (typeof frame.payload === 'string') received.push(frame.payload) })
  })
  await page.addInitScript(() => { localStorage.setItem('i18nextLng', 'en'); localStorage.setItem('fluux-theme', 'dark') })
  try {
    await page.goto('/')
    await page.locator('#jid').fill(config!.users[name].jid)
  } catch (error) {
    if (evidence) {
      const prefix = `${evidence}/room-read-${before ? 'before' : 'after'}-startup-${name}`
      try {
        await page.screenshot({ path: `${prefix}.png` })
        writeFileSync(`${prefix}.html`, await page.content())
      } catch { console.error('Live app startup evidence could not be captured') }
    }
    throw error
  } finally {
    // Stop startup diagnostics before any disposable password enters the page.
    page.off('pageerror', startupError)
    page.off('console', startupConsole)
  }
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
async function joinControl(client: Awaited<ReturnType<typeof peer>>, jid: string, nick = 'Setup') {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { client.off('stanza', handler); reject(new Error('Control room join did not complete')) }, 15_000)
    const handler = (stanza: ReturnType<typeof xml>) => {
      if (stanza.attrs.from !== `${jid}/${nick}` || !stanza.is('presence')) return
      if (stanza.attrs.type === 'error') { clearTimeout(timer); client.off('stanza', handler); reject(new Error('Control room join refused')); return }
      if (!stanza.getChild('x', `${MUC}#user`)?.getChildren('status').some((status: ReturnType<typeof xml>) => status.attrs.code === '110')) return
      clearTimeout(timer); client.off('stanza', handler); resolve()
    }
    client.on('stanza', handler)
    void client.send(xml('presence', { to: `${jid}/${nick}` }, xml('x', { xmlns: MUC }))).catch(reject)
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
  await expect(client.page.getByRole('combobox', { name: `Message #${name}`, exact: true })).toBeVisible({ timeout: 30_000 })
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
  const room = `read-${roomId()}@conference.localhost`
  const publicRoom = `public-${roomId()}@conference.localhost`
  const otherRoom = `other-${roomId()}@conference.localhost`
  const clients: App[] = []
  const crowd: Awaited<ReturnType<typeof peer>>[] = []
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
      await expect(alice.page.getByRole('switch', { name: 'Share room read positions', exact: true })).toHaveAttribute('aria-checked', 'false')
      await shot(alice.page, 'privacy')
      await openRoom(alice)
      await alice.page.getByTestId('room-info-area').getByRole('button').click()
      await shot(alice.page, 'room-details')
      return
    }
    await expect(alice.page.getByRole('switch', { name: 'Share room read positions', exact: true })).toHaveCount(0)
    await shot(alice.page, 'privacy')
    await openRoom(alice)
    mark(bob, 'reading-focus')
    await roomConsent(alice, true)
    // Closing the chooser exposes the timeline without an artificial refocus.
    await expect.poll(() => displayed(alice).length).toBe(1)
    await bob.page.bringToFront()
    const readerNames = bob.page.locator('[data-read-marker-names]').filter({ hasText: /^Alice$/ })
    await privacy(bob)
    await expect(bob.page.getByRole('switch', { name: 'Share room read positions', exact: true })).toHaveCount(0)
    await openRoom(bob)
    await roomConsent(bob, true)
    // A short list is now plain text. The demo browser suite owns overflow
    // activation and dialog focus; this journey owns actual-service visibility.
    await expect(readerNames).toBeVisible()
    await expect(readerNames.locator('..').getByRole('button')).toHaveCount(0)
    await roomConsent(bob, false)
    await expect(readerNames).toHaveCount(0)
    await roomConsent(bob, true)
    await expect(readerNames).toBeVisible()
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
    await expect.poll(() => displayed(alice).length).toBe(paneHeld + 1)
    await alice.page.setViewportSize({ width: 1280, height: 800 })

    // The headed runner can lose real focus without changing document visibility.
    // Disable its default focus emulation only for this native focus boundary.
    const focusSession = await alice.context.newCDPSession(alice.page)
    let away: Page | undefined
    try {
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false })
      away = await alice.context.newPage(); await away.goto('about:blank'); await away.bringToFront()
      await expect.poll(() => alice.page.evaluate(() => document.hasFocus())).toBe(false)
      const held = displayed(alice).length
      await say(bob, content[1])
      await expect.poll(() => alice.received.some(frame => frame.includes(content[1]))).toBe(true)
      await noPublication(alice, held, 'unfocused-window')
      await alice.page.bringToFront()
      await expect.poll(() => alice.page.evaluate(() => document.hasFocus())).toBe(true)
      await away.close(); away = undefined
      await expect.poll(() => displayed(alice).length).toBe(held + 1)
    } finally {
      await away?.close().catch(() => {})
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
      await focusSession.detach().catch(() => {})
    }
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
    await expect(bob.page.locator('[data-read-marker-names]').filter({ hasText: /^AliceRenamed$/ })).toBeVisible()
    await shot(bob.page, 'nick-change')

    // Remove only protocol resumption state after unload has flushed it, while
    // preserving the tab's sign-in. A fresh stream must replay archived markers.
    await bob.page.addInitScript(() => {
      for (const key of Object.keys(sessionStorage)) {
        if (key.startsWith('fluux:session:') || key.startsWith('fluux:session-unconfirmed:')) sessionStorage.removeItem(key)
      }
    })
    const replayStart = bob.sent.length
    try {
      await bob.page.reload()
      await openRoom(bob)
      await expect(bob.page.locator('[data-read-marker-names]').filter({ hasText: /^AliceRenamed$/ })).toBeVisible({ timeout: 30_000 })
      expect(bob.sent.slice(replayStart).filter(frame => /<(?:[\w.-]+:)?resume(?:\s|\/?>)/.test(frame)),
        'archive replay uses a fresh stream, not stream resumption').toHaveLength(0)
      await noPublication(bob, 0, 'replay-without-new-incoming-reading')
      await shot(bob.page, 'archive-replay')
    } catch (error) {
      if (evidence) await bob.page.screenshot({ path: `${evidence}/room-read-after-archive-replay-failure.png`,
        mask: [bob.page.locator('input[type=password]')] }).catch(() => console.error('Archive-replay failure view could not be captured'))
      throw error
    }

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

    const archiveId = async (needle: string) => {
      const frame = alice.received.find(frame => frame.startsWith('<message') && frame.includes(needle))
      if (!frame) throw new Error('Expected incoming room packet was not received')
      return alice.page.evaluate(({ frame, room }) => {
        const packet = new DOMParser().parseFromString(frame, 'application/xml')
        const id = Array.from(packet.getElementsByTagNameNS('urn:xmpp:sid:0', 'stanza-id'))
          .find(item => item.getAttribute('by') === room)?.getAttribute('id')
        if (!id) throw new Error('Expected incoming room packet has no room archive ID')
        return id
      }, { frame, room })
    }
    // These are real incoming encrypted and private-sync packets, not viewport stand-ins.
    await openRoom(alice); await roomConsent(alice, true, 'room-details-reenabled')
    await openRoom(bob)
    const resumedId = await archiveId(content[2])
    await alice.page.bringToFront()
    await expect.poll(() => displayed(alice).some(frame => frame.includes(resumedId))).toBe(true)
    const { publicKey } = await generateKey({ type: 'ecc', curve: 'curve25519Legacy',
      userIDs: [{ name: 'Disposable room proof' }], format: 'object' })
    const ciphertext = await encrypt({ message: await createMessage({ text: 'Private room reading proof' }), encryptionKeys: publicKey, format: 'binary' })
    const encryptedId = randomUUID()
    await joinControl(member, room, 'EncryptedSender')
    const controlId = randomUUID()
    const controlBody = 'Plaintext control with the encrypted sender present'
    await member.send(xml('message', { type: 'groupchat', to: room, id: controlId }, xml('body', {}, controlBody)))
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: controlBody })).toBeInViewport()
    const controlArchiveId = await archiveId(controlId)
    await expect.poll(() => displayed(alice).some(frame => frame.includes(controlArchiveId))).toBe(true)
    const encryptedHeld = displayed(alice).length
    await member.send(xml('message', { type: 'groupchat', to: room, id: encryptedId },
      xml('body', {}, 'Protected room payload fallback'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' }),
      xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, Buffer.from(ciphertext).toString('base64'))))
    await alice.page.bringToFront()
    await expect.poll(() => alice.received.some(frame => frame.includes(encryptedId))).toBe(true)
    const encryptedRow = alice.page.locator(`[data-stanza-id="${await archiveId(encryptedId)}"]`)
    await expect(encryptedRow).toBeInViewport()
    await expect(encryptedRow.getByText('Encryption disabled. Enable it in the settings', { exact: true })).toBeVisible()
    await expect(encryptedRow).not.toContainText('Protected room payload fallback')
    await shot(alice.page, 'encrypted-row')
    await noPublication(alice, encryptedHeld, 'encrypted-row')
    await member.send(xml('presence', { to: `${room}/EncryptedSender`, type: 'unavailable' }))
    await expect.poll(() => alice.received.some(frame => frame.includes(`${room}/EncryptedSender`) && /type=['"]unavailable['"]/.test(frame))).toBe(true)

    await openRoom(alice, otherTitle)
    const syncHeld = displayed(alice).length
    const syncBody = 'Another device read this private room message'
    await bob.page.bringToFront(); await say(bob, syncBody)
    await expect.poll(() => alice.received.some(frame => frame.includes(syncBody))).toBe(true)
    const unread = alice.page.locator(`[data-room-jid="${room}"]`).getByRole('img', { name: /unread message/ })
    await expect(unread).toBeVisible()
    const mds = 'urn:xmpp:mds:displayed:0'
    const syncId = await archiveId(syncBody)
    await owner.send(xml('presence'))
    await owner.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
      xml('publish', { node: mds }, xml('item', { id: room }, xml('displayed', { xmlns: mds },
        xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', by: room, id: syncId })))))))
    await expect.poll(() => alice.received.some(frame => frame.includes(mds) && frame.includes(syncId))).toBe(true)
    await expect(unread).toHaveCount(0)
    await noPublication(alice, syncHeld, 'incoming-private-sync')
    await openRoom(alice)
    await expect.poll(() => displayed(alice).some(frame => frame.includes(syncId))).toBe(true)

    // Occupants are actual sessions on the disposable service; discovery must agree with the live roster.
    for (let i = 1; i <= 17; i++) {
      const client = await peer('alice'); crowd.push(client)
      await joinControl(client, room, `Crowd${i}`)
    }
    await expect.poll(() => alice.received.some(frame => frame.includes(`${room}/Crowd17`))).toBe(true)
    const readCount = async () => {
      const reply = await owner.iqCaller.request(xml('iq', { type: 'get', to: room }, xml('query', { xmlns: DISCO })))
      const count = reply.getChild('query', DISCO)?.getChild('x', DATA)?.getChildren('field')
        .find((field: ReturnType<typeof xml>) => field.attrs.var === 'muc#roominfo_occupants')?.getChildText('value')
      return { count: Number(count), stanza: reply.toString() }
    }
    const at19 = await readCount()
    expect(at19.count).toBe(19)
    const nineteenHeld = displayed(alice).length
    await bob.page.bringToFront(); await say(bob, 'Nineteen occupants may share reading')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'Nineteen occupants may share reading' })).toBeInViewport()
    await expect.poll(() => displayed(alice).length).toBeGreaterThan(nineteenHeld)
    const twentieth = await peer('alice'); crowd.push(twentieth)
    await joinControl(twentieth, room, 'Crowd18')
    await expect.poll(() => alice.received.some(frame => frame.includes(`${room}/Crowd18`))).toBe(true)
    const at20 = await readCount()
    expect(at20.count).toBe(20)
    const twentyHeld = displayed(alice).length
    await bob.page.bringToFront(); await say(bob, 'Twenty occupants must not share reading')
    await alice.page.bringToFront()
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'Twenty occupants must not share reading' })).toBeInViewport()
    await noPublication(alice, twentyHeld, 'twenty-occupants')
    if (evidence) writeFileSync(`${evidence}/room-read-eligibility-and-sync.json`, JSON.stringify({ at19, at20, controlArchiveId, encryptedArchiveId: await archiveId(encryptedId), privateSyncArchiveId: syncId }, null, 2))
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
    await Promise.allSettled(crowd.map(client => client.stop()))
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
