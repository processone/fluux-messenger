import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
// @ts-expect-error @xmpp/client ships no type declarations; the live proof only needs the loose shape used below.
import { client as xmppClient, xml } from '@xmpp/client'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Live proof of saved messages against a disposable local ejabberd (loopback only): two real app
// clients of one account, a scripted peer, and the private node read back from the server.
//
//   FLUUX_LIVE_APP=http://localhost:4173 FLUUX_LIVE_ACCOUNTS=/path/accounts.json FLUUX_LIVE_EVIDENCE=/path/dir \
//     npx playwright test --config e2e/playwright.saved-live.config.ts
// accounts.json: { "ws": "ws://127.0.0.1:45380/ws", "users": { "alice": { "jid", "password" }, "bob": { ... } },
//                  "labCtl": "<path of the lab control script, ending in /ctl.sh>" }
const accountsFile = process.env.FLUUX_LIVE_ACCOUNTS
test.skip(!accountsFile, 'FLUUX_LIVE_ACCOUNTS is not set')
const config = accountsFile ? JSON.parse(readFileSync(accountsFile, 'utf8')) as {
  ws: string; users: Record<string, { jid: string; password: string }>; labCtl: string
} : null
const loopback = ['127.0.0.1', 'localhost', '[::1]']
if (config) {
  if (!loopback.includes(new URL(config.ws).hostname)) throw new Error('live proof refuses a non-loopback server')
  if (!process.env.FLUUX_LIVE_APP || !loopback.includes(new URL(process.env.FLUUX_LIVE_APP).hostname)) throw new Error('live proof refuses a non-loopback app')
  for (const name of ['alice', 'bob']) if (config.users[name]?.jid !== `${name}@localhost`) throw new Error(`live proof refuses account address for ${name}`)
  if (!/\/ctl\.sh$/.test(config.labCtl)) throw new Error('live proof refuses a control script that is not the lab one')
}
const evidence = process.env.FLUUX_LIVE_EVIDENCE
const NODE = 'urn:xmpp:fluux:saved-messages:0'
const PUBSUB = 'http://jabber.org/protocol/pubsub'
const stamp = Date.now().toString(36)
// Taken once the pointer is out of the way (a tooltip must not cover the view) and what the page animates in has settled.
const shot = async (page: Page, name: string) => { await page.mouse.move(1270, 790); await page.waitForTimeout(800); await page.screenshot({ path: evidence ? `${evidence}/saved-live-${name}.png` : undefined }) }

interface Client { page: Page; context: BrowserContext; frames: string[]; received: string[] }

const PASSPHRASE = 'correct horse battery staple'
async function connect(browser: Browser, name: 'alice' | 'bob' = 'alice', options: { openpgp?: boolean } = {}): Promise<Client> {
  const { jid, password } = config!.users[name]
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const frames: string[] = []
  const received: string[] = []
  page.on('websocket', ws => {
    ws.on('framesent', frame => { if (typeof frame.payload === 'string') frames.push(frame.payload) })
    ws.on('framereceived', frame => { if (typeof frame.payload === 'string') received.push(frame.payload) })
  })
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await page.goto('/')
  await page.locator('#jid').fill(jid)
  await page.locator('input[type=password]').first().fill(password)
  await page.keyboard.press('Control+,')
  await page.locator('#server').fill(config!.ws)
  await page.getByText('Remember me').click()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  if (options.openpgp) {
    // A real key made by the app itself (openpgp.js) for this throwaway account, as in e2e/forward-direct.live.ts.
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Encryption' }).click()
    await page.getByRole('switch').first().click()
    const fields = page.locator('input[type=password]')
    await fields.nth(0).fill(PASSPHRASE)
    await fields.nth(1).fill(PASSPHRASE)
    await page.getByRole('button', { name: 'Set up', exact: true }).click()
    await expect(page.getByText('Your key is ready and published.')).toBeVisible({ timeout: 60_000 })
  }
  return { page, context, frames, received }
}

/**
 * A scripted account: the peer, and the reader of the private node. Its resource sorts before the app's
 * (`fluux-…`): the lab server stops pushing notifications to the app when a session that never sent presence
 * sorts after it, which is a quirk of that server, not of the client.
 */
async function script(name: 'alice' | 'bob') {
  const { password } = config!.users[name]
  const c = xmppClient({ service: config!.ws, domain: 'localhost', username: name, password, resource: `aaa-${randomUUID().slice(0, 6)}` })
  c.on('error', () => {})
  await c.start()
  const message = (to: string, id: string, children: unknown[], type = 'chat') =>
    c.send(xml('message', { to, type, id }, ...(children as never[])))
  return {
    c,
    /** Send a chat message; returns its id (also its origin id). */
    async say(to: string, body: string) {
      const id = randomUUID()
      await message(`${to}@localhost`, id, [xml('body', {}, body), xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id })])
      return id
    },
    async correct(to: string, target: string, body: string) {
      const id = randomUUID()
      await message(`${to}@localhost`, id, [xml('body', {}, body), xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: target }), xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id })])
    },
    async retract(to: string, target: string) {
      const id = randomUUID()
      await message(`${to}@localhost`, id, [xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: target }), xml('fallback', { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:message-retract:1' }), xml('body', {}, 'This person attempted to retract a previous message, but it\'s unsupported by your client.')])
    },
    /** The raw items the account's private node holds; a failed or malformed read throws instead of looking empty. */
    async items(): Promise<string[]> {
      // A node that does not exist yet holds nothing; any other failed read throws.
      const reply = await c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: PUBSUB }, xml('items', { node: NODE })))).catch((error: { element?: { getChild(name: string): unknown } }) => {
        if (error.element?.getChild('item-not-found')) return undefined
        throw error
      })
      if (!reply) return []
      const items = reply.getChild('pubsub', PUBSUB)?.getChild('items')
      if (!items) throw new Error('the node read returned no items element')
      return items.getChildren('item').map((item: { toString(): string }) => item.toString())
    },
    async stop() { await c.stop().catch(() => {}) },
  }
}

function kick(name: string) { execFileSync(config!.labCtl, ['kick_user', name, 'localhost']) }
/** The two accounts are contacts, so chats between them are ordinary conversations (no message request). */
function befriend() { execFileSync(config!.labCtl, ['add_rosteritem', 'alice', 'localhost', 'bob', 'localhost', 'Bob', 'Friends', 'both']) }

/** Records, from now on, every highlight that appears and every address the app navigates to, even one that is gone a moment later. */
async function watchTransient(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __transient: string[] }
    w.__transient = []
    const note = (what: string) => w.__transient.push(`${what} ${location.pathname}`)
    new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target as HTMLElement
        if (record.type === 'childList') record.addedNodes.forEach((node) => { if (node instanceof HTMLElement && (node.matches('.message-highlight') || node.querySelector('.message-highlight'))) note('highlight') })
        else if (target.classList?.contains('message-highlight')) note('highlight')
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = history[name].bind(history)
      history[name] = (...args: Parameters<History['pushState']>) => { note(`url ${String(args[2])}`); original(...args) }
    }
    window.addEventListener('popstate', () => note('popstate'))
  })
}
const transient = (page: Page) => page.evaluate(() => (window as unknown as { __transient: string[] }).__transient)

async function openChatWith(client: Client, peer: string) {
  const { page } = client
  await page.getByRole('button', { name: 'Messages' }).first().click()
  await page.getByRole('complementary').getByText(peer, { exact: true }).first().click()
  await expect(page.getByRole('combobox', { name: /^Message / })).toBeVisible()
}

async function saveMessage(client: Client, text: string) {
  const row = client.page.locator('[data-message-body]').filter({ hasText: text }).last()
  // The list can re-render under the pointer while history settles: reach the open menu again until it holds.
  await expect(async () => {
    await row.scrollIntoViewIfNeeded({ timeout: 5000 })
    await row.hover({ timeout: 5000 })
    await row.getByRole('button', { name: 'More options', exact: true }).click({ timeout: 5000 })
    await row.getByRole('button', { name: 'Save message', exact: true }).click({ timeout: 3000 })
  }).toPass({ timeout: 30_000 })
}

async function openSaved(client: Client) {
  await client.page.getByRole('link', { name: 'Saved', exact: true }).or(client.page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(client.page).toHaveURL(/\/saved/)
  await client.page.mouse.move(700, 500) // the pointer leaves the rail, so no tooltip covers the page
}

/** A successful answer to a read of the saved node (the server quotes attributes its own way). */
const isItemsResult = (frame: string) => /^<iq\b/.test(frame) && /type=["']result["']/.test(frame) && new RegExp(`<items node=["']${NODE}["']`).test(frame)

const savedRow = (client: Client, text: string) => client.page.getByTestId('saved-row').filter({ hasText: text })

async function nodeHolds(peer: Awaited<ReturnType<typeof script>>, count: number) {
  await expect.poll(async () => (await peer.items()).length, { timeout: 20_000 }).toBe(count)
  return peer.items()
}

// Deleted rather than purged: the app then creates the node itself, with its own configuration, as for a new account.
async function emptyNode(peer: Awaited<ReturnType<typeof script>>) {
  await peer.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('delete', { node: NODE })))).catch(() => {})
}

/** The `<saved/>` wrapper of a raw stored item, parsed back into a stanza element. */
async function parseSavedChildren(rawItem: string) {
  // @ts-expect-error ltx (the parser under @xmpp/xml) ships no type declarations.
  const { parse } = await import('ltx') as unknown as { parse: (text: string) => { getChild(name: string): unknown } }
  return [parse(rawItem.replace(/^<item\b/, `<item xmlns="${PUBSUB}"`)).getChild('saved')]
}

/** Removes any OpenPGP identity an earlier run left on a throwaway account (its public keys and key backup nodes), so a fresh key is made. */
async function forgetOpenpgpIdentity(name: 'alice' | 'bob') {
  const peer = await script(name)
  const reply = await peer.c.iqCaller.request(xml('iq', { type: 'get', to: `${name}@localhost` }, xml('query', { xmlns: 'http://jabber.org/protocol/disco#items' })))
  const nodes = reply.getChild('query').getChildren('item').map((item: { attrs: { node?: string } }) => item.attrs.node).filter((node?: string) => node?.startsWith('urn:xmpp:openpgp:0'))
  for (const node of nodes) await peer.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('delete', { node })))).catch(() => {})
  await peer.stop()
}

test.describe.configure({ mode: 'serial' })
test.beforeAll(() => befriend())
// Sessions left waiting for resumption by an earlier test would also receive (and miss) notifications: start from none.
test.beforeEach(() => { kick('alice'); kick('bob') })

test('two clients of one account stay in step, and the node holds the forwarded copy', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const two = await connect(browser)
  const text = `Meet at the fountain ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)

  // The other client sees it without reloading; the node holds one item with the forwarded copy.
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  const items = await nodeHolds(reader, 1)
  expect(items[0]).toContain('<forwarded')
  expect(items[0]).toContain(text)
  await shot(two.page, 'two-clients-saved')

  // Removal travels the other way.
  await openSaved(one)
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(two, text)).toHaveCount(0)
  await nodeHolds(reader, 0)
  await shot(two.page, 'two-clients-removed')
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('an edit and a retraction made while the conversation is closed reach the row and the stored item', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Original wording ${stamp}`
  const id = await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  // Leave the conversation, then let the sender edit the message.
  await openSaved(one)
  const edited = `Edited wording ${stamp}`
  await bob.correct('alice', id, edited)
  await expect(savedRow(one, edited)).toBeVisible()
  // An edit is shown from the device's cache; the stored item keeps the copy that was saved.
  expect((await reader.items())[0]).toContain(text)
  await shot(one.page, 'inactive-edit')

  // Then retract it: the row says so, and the stored item loses its text.
  await bob.retract('alice', id)
  await expect(savedRow(one, 'Message deleted')).toBeVisible()
  await expect.poll(async () => (await reader.items())[0] ?? '', { timeout: 20_000 }).toContain('deleted="true"')
  const [kept] = await reader.items()
  expect(kept).not.toContain(edited)
  expect(kept).not.toContain(text)
  await shot(one.page, 'inactive-delete')
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved message opens from a device that has never seen it, through the archive', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Only the archive has this ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)
  // Newer traffic pushes the original out of a first page of history.
  for (let i = 0; i < 60; i++) await bob.say('alice', `later ${i} ${stamp}`)

  // A fresh browser has no cache: the row is known from the node, the original only from the archive.
  const [stored] = await reader.items()
  const sentAt = new Date(String(stored.match(/<delay [^>]*stamp="([^"]+)"/)?.[1])).getTime()
  expect(Number.isFinite(sentAt)).toBe(true)
  const two = await connect(browser)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await expect(two.page.locator('[data-message-body]').filter({ hasText: text })).toHaveCount(0) // not resident
  const before = two.frames.length
  await savedRow(two, text).click()
  await expect(two.page.locator('.message-highlight').filter({ hasText: text })).toBeInViewport({ timeout: 30_000 })
  // The lookup was aimed at the target: an archive query bounded to a window around when it was sent.
  const aimed = two.frames.slice(before).filter(frame => frame.includes('urn:xmpp:mam:2') && frame.includes('var="start"')).some((frame) => {
    const start = Date.parse(frame.match(/var="start"><value>([^<]+)</)?.[1] ?? '')
    const end = Date.parse(frame.match(/var="end"><value>([^<]+)</)?.[1] ?? '')
    return start <= sentAt && sentAt <= end
  })
  expect(aimed).toBe(true)
  await shot(two.page, 'archive-navigation')

  // The first browser holds the original in its cache: with the server unreachable it still opens it, with no archive query.
  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await openSaved(one)
  const beforeCache = one.frames.length
  await savedRow(one, text).click()
  await expect(one.page.locator('.message-highlight').filter({ hasText: text })).toBeInViewport({ timeout: 30_000 })
  expect(one.frames.slice(beforeCache).some(frame => frame.includes('urn:xmpp:mam:2'))).toBe(false)
  refuse = false
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('a full node refuses one more save and evicts nothing, at the limit the server actually keeps', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  // Start from no node: the app creates it, with whatever limit this server grants.
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('delete', { node: NODE })))).catch(() => {})
  const one = await connect(browser)
  const first = `First of many ${stamp}`
  await bob.say('alice', first)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: first })).toBeVisible()
  await saveMessage(one, first)
  await nodeHolds(reader, 1)

  // The limit the server holds the node to, read from its configuration: the node the app creates names a number.
  const form = await reader.c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('configure', { node: NODE }))))
  const limit = Number.parseInt(String(form.toString().match(/pubsub#max_items[^]*?<value>([^<]*)<\/value>/)?.[1]), 10)
  expect(limit).toBeGreaterThan(1)
  const seed = (id: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`))))))))
  for (let i = 0; i < limit - 1; i++) await reader.c.iqCaller.request(seed(`seed${String(i).padStart(3, '0')}`))
  expect((await reader.items()).length).toBe(limit)

  // One more save must not push anything out: it is refused, and the person is told.
  const text = `One too many ${stamp}`
  await bob.say('alice', text)
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await expect(one.page.getByText(/Saved messages are full/)).toBeVisible()
  await one.page.waitForTimeout(2500) // the toast has settled
  await shot(one.page, 'cap-refused')
  const items = await reader.items()
  expect(items.length).toBe(limit)
  expect(items.some(item => item.includes(text))).toBe(false)
  expect(items.some(item => item.includes(first))).toBe(true)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

// Needs a server whose ceiling is known (FLUUX_LIVE_CEILING, the lab's max_items_node) and which reports a node kept at `max`
// as `max`: nothing may then be assumed of how many items it keeps, so the app holds a further save back.
test('a node that only says max is never pushed past the ceiling the server enforces', async ({ browser }) => {
  const ceiling = Number.parseInt(process.env.FLUUX_LIVE_CEILING ?? '', 10)
  test.skip(!Number.isFinite(ceiling), 'FLUUX_LIVE_CEILING names the lab server\'s own node ceiling')
  const bob = await script('bob')
  const reader = await script('alice')
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('delete', { node: NODE })))).catch(() => {})
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', 'max'), field('pubsub#send_last_published_item', 'never')))
  const seed = (id: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`)))))), options))
  for (let i = 0; i < ceiling; i++) await reader.c.iqCaller.request(seed(`seed${String(i).padStart(3, '0')}`))
  expect((await reader.items()).length).toBe(ceiling)
  expect(String((await reader.c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('configure', { node: NODE })))))).includes('<value>max</value>')).toBe(true)

  const one = await connect(browser)
  const text = `Would push one out ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  const sentBefore = one.frames.length
  await saveMessage(one, text)
  await one.page.waitForTimeout(8000)
  // Nothing was published for it, and the save is still queued on this device.
  expect(one.frames.slice(sentBefore).filter(frame => frame.includes(`<publish node="${NODE}"`)).length).toBe(0)
  await expect.poll(() => one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join('')), { timeout: 10_000 }).toContain(text.slice(0, 12))
  const items = await reader.items()
  expect(items.length).toBe(ceiling)
  expect(items.some(item => item.includes(text))).toBe(false)
  expect(items.some(item => item.includes('id="seed000"'))).toBe(true)
  await shot(one.page, 'max-node-held-back')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a save made offline survives a reload and is sent once after the reconnect', async ({ browser }) => {
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Saved while offline ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()

  // The server cannot be reached: the session is ended and every new connection is refused.
  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice') // ends the reader's session too
  reader = await script('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await saveMessage(one, text)
  await expect.poll(() => one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join('')), { timeout: 10_000 }).toContain(text.slice(0, 12))
  expect((await reader.items()).length).toBe(0)
  await shot(one.page, 'offline-save')

  // Reload: nothing was sent, and the queued save is read back from this device after the page restarts.
  await one.page.reload()
  await expect.poll(() => one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join('')), { timeout: 10_000 }).toContain(text.slice(0, 12))
  expect((await reader.items()).length).toBe(0)

  // The server is reachable again and the page starts once more: the save is sent once, and the queue empties.
  refuse = false
  await one.page.reload()
  await nodeHolds(reader, 1)
  await expect.poll(() => one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join('')), { timeout: 20_000 }).not.toContain(text.slice(0, 12))
  await new Promise(resolve => setTimeout(resolve, 3000))
  expect((await reader.items()).length).toBe(1)
  // Counted on the wire: the queued save was published exactly once across the reload and reconnect.
  expect(one.frames.filter(frame => frame.includes(`<publish node="${NODE}"`)).length).toBe(1)
  await openSaved(one)
  await expect(savedRow(one, text)).toHaveCount(1, { timeout: 45_000 })
  await shot(one.page, 'offline-save-sent')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a removal made on the second client reaches the first and the node', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const two = await connect(browser)
  const text = `Removed from the other side ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await openSaved(one)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await savedRow(two, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(one, text)).toHaveCount(0)
  await nodeHolds(reader, 0)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('a removal made offline survives a reload and is sent once after the reconnect', async ({ browser }) => {
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Removed while offline ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  reader = await script('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await openSaved(one)
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(one, text)).toHaveCount(0)
  const queued = () => one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join(''))
  await expect.poll(queued, { timeout: 10_000 }).toContain('retract')
  expect((await reader.items()).length).toBe(1) // the server still holds it

  await one.page.reload()
  await expect.poll(queued, { timeout: 10_000 }).toContain('retract')
  expect((await reader.items()).length).toBe(1)

  refuse = false
  await one.page.reload()
  await nodeHolds(reader, 0)
  await expect.poll(queued, { timeout: 20_000 }).not.toContain('retract')
  expect(one.frames.filter(frame => frame.includes(`<retract node="${NODE}"`)).length).toBe(1)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved message whose original no longer exists says so instead of opening nothing', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const text = `Never sent ${stamp}`
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', '256'), field('pubsub#send_last_published_item', 'never')))
  // An item for a message the archive has never held (the other device saved it, then it disappeared).
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id: `ghost${stamp}` }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('delay', { xmlns: 'urn:xmpp:delay', stamp: new Date(Date.now() - 3_600_000).toISOString() }),
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost/x', to: 'alice@localhost', type: 'chat', id: `ghost-${stamp}` }, xml('body', {}, text)))))), options)))
  const one = await connect(browser)
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await savedRow(one, text).click()
  // The row's own status, not the opener's toast, which carries the same words.
  await expect(savedRow(one, text).getByRole('status')).toContainText(/no longer available|Could not load/i, { timeout: 30_000 })
  await expect(one.page).toHaveURL(/\/saved/)
  await shot(one.page, 'original-missing')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a deletion made while this device was away is applied to the saved row and the stored item once it is back', async ({ browser }) => {
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Deleted while away ${stamp}`
  const id = await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  // The device cannot reach the server while the sender retracts the message.
  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  reader = await script('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await bob.retract('alice', id)
  refuse = false
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, 'Message deleted')).toBeVisible({ timeout: 45_000 })
  await expect.poll(async () => (await reader.items())[0] ?? '', { timeout: 30_000 }).toContain('deleted="true"')
  expect((await reader.items())[0]).not.toContain(text)
  await shot(one.page, 'deleted-while-away')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved room message opens in a room this device never joined', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const room = `proof${stamp}@conference.localhost`
  const text = `Said in the room ${stamp}`
  const BOOKMARKS = 'urn:xmpp:bookmarks:1'
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', 'max'), field('pubsub#send_last_published_item', 'never')))
  const bookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name: 'Proof room', autojoin: 'true' }, xml('nick', {}, 'alice')))), options)))
  const unbookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room })))))

  // The room exists, with one message in it, before the first device joins.
  await bob.c.send(xml('presence', { to: `${room}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await bob.c.send(xml('message', { to: room, type: 'groupchat', id: randomUUID() }, xml('body', {}, text)))
  await bookmark()

  const one = await connect(browser)
  await one.page.getByRole('button', { name: 'Rooms' }).first().click()
  await one.page.getByRole('complementary').getByText('Proof room', { exact: true }).first().click()
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  // The bookmark goes away: a device that connects now has not joined, and does not list, this room.
  await unbookmark()
  const two = await connect(browser)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await savedRow(two, text).click()
  // The room is shown but not joined; the person's own join continues the open.
  await expect(two.page).toHaveURL(/\/rooms\//)
  await watchTransient(two.page)
  await two.page.getByRole('button', { name: 'Join room to participate' }).click()
  const join = two.page.getByRole('button', { name: /^Join$/ })
  if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click()
  await expect(two.page.locator('.message-highlight').filter({ hasText: text })).toBeInViewport({ timeout: 30_000 })
  expect(await transient(two.page)).toContain(`highlight ${new URL(two.page.url()).pathname}`) // the recorder does see a continuation when there is one
  await shot(two.page, 'unjoined-room')
  await emptyNode(reader)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('an end-to-end encrypted message is saved without any readable body', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const fallback = `I sent you an encrypted message ${stamp}`
  const id = randomUUID()
  await bob.c.send(xml('message', { to: 'alice@localhost', type: 'chat', id },
    xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'dGhpcyBpcyBub3QgYSByZWFsIG9wZW5wZ3AgcGF5bG9hZA=='),
    xml('body', {}, fallback), xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' }),
    xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id })))
  // This browser has no OpenPGP key, so the message is not readable here and only its fallback is shown.
  await openChatWith(one, 'Bob')
  const row = one.page.locator('[data-message-body]').last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
  const [item] = await nodeHolds(reader, 1)
  expect(item).toContain('encrypted="true"')
  expect(item).not.toContain('<body')
  expect(item).not.toContain(fallback)
  expect(item).not.toContain('dGhpcyBpcyBub3QgYSByZWFsIG9wZW5wZ3AgcGF5bG9hZA')
  await openSaved(one)
  await expect(one.page.getByTestId('saved-row').first()).toContainText(/encrypted/i)
  await expect(one.page.getByTestId('saved-row').first()).not.toContainText(fallback)
  await shot(one.page, 'encrypted-row')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('the private node the app creates answers only its owner', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  // The node is created by the app, with a message in it.
  const one = await connect(browser)
  const text = `Private note ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  // The owner reads it back, so the refusals below are about access and not about a missing node.
  const stored = await nodeHolds(reader, 1)
  expect(stored[0]).toContain(text)

  // Both probes must be answered with an access refusal, not any failure: another failure would prove nothing of privacy.
  const refusal = async (request: Promise<unknown>) => {
    const error = await request.then(() => undefined, (e: { element?: { getChild(name: string): unknown; toString(): string } }) => e)
    expect(error, 'the server answered the foreign request with an error').toBeDefined()
    expect(['forbidden', 'not-allowed'].some(condition => error!.element?.getChild(condition))).toBe(true)
  }
  await refusal(bob.c.iqCaller.request(xml('iq', { type: 'get', to: 'alice@localhost' }, xml('pubsub', { xmlns: PUBSUB }, xml('items', { node: NODE })))))
  await refusal(bob.c.iqCaller.request(xml('iq', { type: 'set', to: 'alice@localhost' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: NODE }, xml('item', { id: 'intruder' }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() })))))))
  const after = await reader.items()
  expect(after.length).toBe(1)
  expect(after.some(item => item.includes('intruder'))).toBe(false)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a client that was offline catches up on a save and a removal made elsewhere', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const two = await connect(browser)
  const kept = `Saved after the other went away ${stamp}`
  const gone = `Removed while the other was away ${stamp}`
  await bob.say('alice', gone)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: gone })).toBeVisible()
  await saveMessage(one, gone)
  await openSaved(two)
  await expect(savedRow(two, gone)).toBeVisible()

  // The second client loses its connection; the first saves one message and removes the other.
  await two.context.setOffline(true)
  await bob.say('alice', kept)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: kept })).toBeVisible()
  await saveMessage(one, kept)
  await nodeHolds(reader, 2)
  await openSaved(one)
  await savedRow(one, gone).getByRole('button', { name: 'Remove from saved' }).click()
  await nodeHolds(reader, 1)

  // Back online, the second client reads the node again and shows both changes.
  await two.context.setOffline(false)
  await two.page.reload()
  await openSaved(two)
  await expect(savedRow(two, kept)).toBeVisible({ timeout: 30_000 })
  await expect(savedRow(two, gone)).toHaveCount(0)
  await shot(two.page, 'offline-client-caught-up')
  await emptyNode(reader)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

// Transport injection, not a server refusal: the page's own socket is routed and the removal request is answered with
// the error a server gives a stranger, without being forwarded. It proves how the app treats a refused removal, not that the server refuses one.
test('a removal the server refuses brings the row back and leaves the node untouched, then succeeds once allowed', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Refused removal ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()

  // Reload under a routed socket that answers a removal of the saved node with `forbidden`.
  let refuse = true
  let refused = 0
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      const id = /^<iq\b[^>]*\bid="([^"]+)"/.exec(frame)?.[1]
      if (refuse && id && frame.includes(`<retract node="${NODE}"`)) {
        refused++
        ws.send(`<iq xmlns="jabber:client" type="error" id="${id}"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`)
        return
      }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible({ timeout: 45_000 })
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect.poll(() => refused, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(savedRow(one, text)).toBeVisible({ timeout: 20_000 }) // restored, not silently gone
  expect((await reader.items()).length).toBe(1)
  await shot(one.page, 'removal-refused')

  // Allowed again: the same removal now goes through.
  refuse = false
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(one, text)).toHaveCount(0)
  await nodeHolds(reader, 0)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved room message without an archive id opens in a room this device never joined', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const room = `noid${stamp}@conference.localhost`
  const text = `Said without an id ${stamp}`
  const BOOKMARKS = 'urn:xmpp:bookmarks:1'
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = (max: string) => xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', max), field('pubsub#send_last_published_item', 'never')))
  await bob.c.send(xml('presence', { to: `${room}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await bob.c.send(xml('message', { to: room, type: 'groupchat', id: randomUUID() }, xml('body', {}, text)))
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name: 'No id room', autojoin: 'true' }, xml('nick', {}, 'alice')))), options('max'))))

  const one = await connect(browser)
  await one.page.getByRole('button', { name: 'Rooms' }).first().click()
  await one.page.getByRole('complementary').getByText('No id room', { exact: true }).first().click()
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  await saveMessage(one, text)
  const [saved] = await nodeHolds(reader, 1)
  expect(saved).toContain('<stanza-id')

  // The stored copy loses its archive id (as an entry saved before the room's archive id was known would), and the room is no longer listed.
  const itemId = /<item id="([^"]+)"/.exec(saved)![1]
  const stripped = saved.replace(/<stanza-id\b[^>]*\/>/g, '')
  expect(stripped).not.toContain('<stanza-id')
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: NODE }, xml('item', { id: itemId }, ...(await parseSavedChildren(stripped)))), options('256'))))
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room })))))
  const [rewritten] = await reader.items()
  expect(rewritten).toContain(text)
  expect(rewritten).not.toContain('<stanza-id') // the node now really holds an entry without an archive id

  const two = await connect(browser)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await savedRow(two, text).click()
  await expect(two.page).toHaveURL(/\/rooms\//)
  await two.page.getByRole('button', { name: 'Join room to participate' }).click()
  const join = two.page.getByRole('button', { name: /^Join$/ })
  if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click()
  await expect(two.page.locator('.message-highlight').filter({ hasText: text })).toBeInViewport({ timeout: 30_000 })
  await shot(two.page, 'room-without-archive-id')
  await emptyNode(reader)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('a message really decrypted on this device is saved without its text, and a later edit and a fetch keep it out', async ({ browser }) => {
  test.setTimeout(240_000)
  await forgetOpenpgpIdentity('alice'); await forgetOpenpgpIdentity('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser, 'alice', { openpgp: true })
  const bobApp = await connect(browser, 'bob', { openpgp: true })
  const text = `Really encrypted ${stamp}`
  const edited = `Edited and encrypted ${stamp}`
  const say = async (client: Client, peer: string, body: string) => {
    await client.page.getByRole('button', { name: 'Messages' }).first().click()
    const entry = client.page.getByRole('complementary').getByText(peer, { exact: true }).first()
    if (!(await entry.isVisible({ timeout: 3000 }).catch(() => false))) {
      await client.page.getByRole('button', { name: /^Contacts/ }).click()
      await client.page.getByText(peer, { exact: true }).first().dblclick()
    } else await entry.click()
    const composer = client.page.getByRole('combobox', { name: /^Message / })
    const accept = client.page.getByRole('button', { name: 'Accept' }).first()
    if (await accept.isVisible({ timeout: 2000 }).catch(() => false)) await accept.click() // a first message from a stranger is a request
    await composer.click(); await composer.pressSequentially(body); await composer.press('Enter')
    await expect(client.page.locator('[data-message-body]').filter({ hasText: body }).last()).toBeVisible()
  }
  await say(one, 'Bob', `Hello ${stamp}`) // alice starts, so each side holds the other's key and the chat exists on both
  await bobApp.page.getByRole('button', { name: 'Messages' }).first().click()
  await expect.poll(() => bobApp.page.getByRole('complementary').getByText('alice', { exact: true }).count(), { timeout: 30_000 }).toBeGreaterThan(0)
  await say(bobApp, 'alice', text)
  expect(bobApp.frames.filter(f => f.startsWith('<message') && f.includes(text))).toHaveLength(0) // the wire carries no plaintext
  expect(bobApp.frames.some(f => f.startsWith('<message') && f.includes('urn:xmpp:openpgp:0'))).toBe(true)

  // Alice reads it decrypted, and saves it.
  await openChatWith(one, 'Bob')
  const row = one.page.locator('[data-message-body]').filter({ hasText: text }).last()
  await expect(row).toBeVisible({ timeout: 30_000 }) // decrypted here
  await saveMessage(one, text)
  const [item] = await nodeHolds(reader, 1)
  expect(item).toContain('encrypted="true"')
  expect(item).not.toContain('<body')
  expect(item).not.toContain(text)
  expect(item).not.toContain('Really encrypted')

  // Bob corrects it (an encrypted correction); the stored item never gains plaintext.
  const bobRow = bobApp.page.locator('[data-message-body]').filter({ hasText: text }).last()
  await bobRow.hover()
  await bobRow.getByRole('button', { name: 'Edit message', exact: true }).click()
  const editor = bobApp.page.getByRole('combobox', { name: /^Message / })
  await editor.press('ControlOrMeta+a')
  await editor.pressSequentially(edited)
  await editor.press('Enter')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: edited })).toBeVisible({ timeout: 30_000 })
  await new Promise(resolve => setTimeout(resolve, 3000))
  for (const raw of await reader.items()) { expect(raw).not.toContain('Really encrypted'); expect(raw).not.toContain('Edited and encrypted') }

  // The app itself reads the node again: a reconnect makes it fetch the saved items (counted on its own socket), and the
  // fetched copy must neither show nor write back anything readable.
  // No push of the node reaches the page from here on, and a second item is stored meanwhile: only a fetch can bring it in.
  let dropPushes = true
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => server.send(message))
    server.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (dropPushes && /^<message\b/.test(frame) && frame.includes('<event') && frame.includes(NODE)) return
      ws.send(message)
    })
  })
  const fetchedOnly = `Only a fetch brings this ${stamp}`
  // A reconnect first, so that the page's socket is the one this route covers.
  const firstFetches = one.frames.filter(f => f.includes(`<items node="${NODE}"`)).length
  kick('alice')
  await expect.poll(() => one.frames.filter(f => f.includes(`<items node="${NODE}"`)).length, { timeout: 60_000 }).toBeGreaterThan(firstFetches)
  await reader.stop().catch(() => {})
  const reader2 = await script('alice')
  await reader2.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id: `fetched-only-${stamp}` }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `fo-${stamp}` }, xml('body', {}, fetchedOnly)))))))))
  const fetchesBefore = one.frames.filter(f => f.includes(`<items node="${NODE}"`)).length
  const answersBefore = one.received.length
  await openSaved(one)
  await expect(savedRow(one, fetchedOnly)).toHaveCount(0) // not known to the page yet
  kick('alice') // ends the reader's session too
  await expect.poll(() => one.frames.filter(f => f.includes(`<items node="${NODE}"`)).length, { timeout: 60_000 }).toBeGreaterThan(fetchesBefore)
  // The server's successful answer to that read reaches the page, and carries the encrypted copy and the new item.
  await expect.poll(() => one.received.slice(answersBefore).some(f => isItemsResult(f) && /encrypted=["']true["']/.test(f) && f.includes(fetchedOnly)), { timeout: 60_000 }).toBe(true)
  expect(one.received.slice(answersBefore).filter(isItemsResult).every(f => !f.includes('Really encrypted') && !f.includes('Edited and encrypted'))).toBe(true)
  // The answer was applied: the item that only it carried is now listed, beside the encrypted one.
  await expect(savedRow(one, fetchedOnly)).toBeVisible({ timeout: 30_000 })
  expect(await one.page.getByTestId('saved-row').count()).toBe(2)
  dropPushes = false
  await reader2.stop().catch(() => {})
  const again = await script('alice')
  await new Promise(resolve => setTimeout(resolve, 3000))
  const after = await again.items()
  expect(after.length).toBe(2)
  const encryptedItems = after.filter(raw => raw.includes('encrypted="true"'))
  expect(encryptedItems).toHaveLength(1)
  for (const raw of after) { expect(raw).not.toContain('Edited and encrypted'); expect(raw).not.toContain('Really encrypted') }
  expect(encryptedItems[0]).not.toContain('<body')
  await shot(one.page, 'decrypted-saved-row')
  await emptyNode(again)
  await one.context.close(); await bobApp.context.close(); await again.stop()
})

test('a save onto a node that already exists with another limit succeeds, because the lab server enforces publish-option preconditions', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = (max: string) => xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', max), field('pubsub#send_last_published_item', 'never')))
  const seed = (id: string, max: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`)))))), options(max)))
  // The node exists, empty, with a limit of 100.
  await reader.c.iqCaller.request(seed('first', '100'))
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('retract', { node: NODE, notify: 'false' }, xml('item', { id: 'first' })))))
  expect((await reader.items()).length).toBe(0)
  // The server refuses a publish whose options differ from the node's: its precondition rules are in force here.
  const refused = await reader.c.iqCaller.request(seed('second', 'max')).then(() => 'accepted', (error: unknown) => String((error as { stanza?: { toString(): string } }).stanza ?? error))
  expect(refused).not.toBe('accepted')
  expect(refused).toMatch(/precondition/i)

  const one = await connect(browser)
  const text = `Saved onto a node with another limit ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  const [saved] = await nodeHolds(reader, 1)
  expect(saved).toContain(text)
  await expect(one.page.getByText(/Your server refused/i)).toHaveCount(0)
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await shot(one.page, 'precondition-existing-node')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

const pendingQueue = (client: Client) => client.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved-pending')).map(([, value]) => value).join(''))

test('a fetch the server never answers leaves the loaded list and the node alone, past the request deadline, and a later fetch is answered', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Fetch unanswered ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible() // the list is loaded in this very session: no reload empties it

  // The reconnect that follows asks for the node, and the server is never asked.
  let swallow = false
  const swallowedAt: number[] = []
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (swallow && /^<iq\b/.test(frame) && frame.includes(`<items node="${NODE}"`)) { swallowedAt.push(Date.now()); return }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  swallow = true
  kick('alice')
  await reader.stop().catch(() => {})
  reader = await script('alice')
  await expect.poll(() => swallowedAt.length, { timeout: 60_000 }).toBeGreaterThan(0)
  // The request deadline (30 s, the transport's) passes with no answer.
  const sentBefore = one.frames.length
  await one.page.waitForTimeout(Math.max(0, swallowedAt[0] + 33_000 - Date.now()))
  expect(Date.now() - swallowedAt[0]).toBeGreaterThanOrEqual(32_000)
  await expect(savedRow(one, text)).toBeVisible() // the row loaded before is still listed
  await expect(one.page.getByText(/Your server refused/i)).toHaveCount(0)
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`) || f.includes(`<retract node="${NODE}"`))).toHaveLength(0)
  expect((await reader.items()).length).toBe(1)
  await shot(one.page, 'fetch-unanswered')

  // The server answers the next read: the row is still there, once.
  swallow = false
  const answersBefore = one.received.length
  kick('alice')
  await reader.stop().catch(() => {})
  reader = await script('alice')
  await expect.poll(() => one.received.slice(answersBefore).some(f => isItemsResult(f)), { timeout: 60_000 }).toBe(true)
  await expect(savedRow(one, text)).toHaveCount(1)
  expect((await reader.items()).length).toBe(1)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a removal the server never answers is sent again once the request deadline has passed, stays removed meanwhile and is never reported refused', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const first = `Removal timeout ${stamp}`
  const second = `Removed after it ${stamp}`
  await bob.say('alice', first)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: first })).toBeVisible()
  await saveMessage(one, first)
  await nodeHolds(reader, 1)
  await bob.say('alice', second)
  await expect(one.page.locator('[data-message-body]').filter({ hasText: second })).toBeVisible()
  await saveMessage(one, second)
  await nodeHolds(reader, 2)
  await openSaved(one)
  await expect(savedRow(one, first)).toBeVisible()
  await expect(savedRow(one, second)).toBeVisible()

  // Only the first removal goes unanswered; any other is passed on and answered.
  let release = false
  let firstItem: string | undefined
  const swallowedAt: number[] = []
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (/^<iq\b/.test(frame) && frame.includes(`<retract node="${NODE}"`)) {
        const item = /<item id="([^"]+)"/.exec(frame)?.[1]
        firstItem ??= item
        if (!release && item === firstItem) { swallowedAt.push(Date.now()); return }
      }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, first)).toBeVisible({ timeout: 45_000 })
  await expect(savedRow(one, second)).toBeVisible()
  await savedRow(one, first).getByRole('button', { name: 'Remove from saved' }).click()
  await expect.poll(() => swallowedAt.length, { timeout: 20_000 }).toBe(1)
  await one.page.waitForTimeout(5000)
  // A second removal is queued behind the unanswered one: nothing else leaves while the request is outstanding.
  await savedRow(one, second).getByRole('button', { name: 'Remove from saved' }).click()
  await one.page.waitForTimeout(5000)
  expect((await reader.items()).length).toBe(2) // inside the deadline, neither removal has reached the server
  // The deadline (30 s, the transport's) passes: the app moves on, sends the first removal again, then the second.
  await expect.poll(() => swallowedAt.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
  expect(swallowedAt[1] - swallowedAt[0]).toBeGreaterThanOrEqual(29_000) // the resend came only after the first request expired
  await expect(savedRow(one, first)).toHaveCount(0) // silence is not a refusal: the row does not come back
  await expect(one.page.getByText(/Your server refused/i)).toHaveCount(0)
  expect(await pendingQueue(one)).toContain('retract')
  await shot(one.page, 'removal-unanswered')

  // Heard again: the first removal goes through and the node empties.
  release = true
  await one.page.reload()
  await nodeHolds(reader, 0)
  await expect.poll(() => pendingQueue(one), { timeout: 20_000 }).not.toContain('retract')
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a save removed again while offline is never sent, and the node stays empty after the reconnect', async ({ browser }) => {
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Saved then removed offline ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()

  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  reader = await script('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await saveMessage(one, text)
  await expect.poll(() => pendingQueue(one), { timeout: 10_000 }).toContain(text.slice(0, 12))
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(one, text)).toHaveCount(0)
  await shot(one.page, 'save-then-remove-offline')

  refuse = false
  await one.page.reload()
  await expect.poll(() => one.frames.some(f => f.includes('<items node=')), { timeout: 45_000 }).toBe(true) // back online and reading the node
  await new Promise(resolve => setTimeout(resolve, 8000))
  expect(one.frames.filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0) // the replaced save is never published
  expect((await reader.items()).length).toBe(0)
  expect(await pendingQueue(one)).not.toContain(text.slice(0, 12))
  await openSaved(one)
  await expect(savedRow(one, text)).toHaveCount(0)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a removal the server refuses at a full node leaves it full: the next save is still refused and nothing is evicted', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const first = `Kept at the limit ${stamp}`
  await bob.say('alice', first)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: first })).toBeVisible()
  await saveMessage(one, first)
  await nodeHolds(reader, 1)
  const form = await reader.c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('configure', { node: NODE }))))
  const limit = Number.parseInt(String(form.toString().match(/pubsub#max_items[^]*?<value>([^<]*)<\/value>/)?.[1]), 10)
  expect(limit).toBeGreaterThan(1)
  const seed = (id: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`))))))))
  for (let i = 0; i < limit - 1; i++) await reader.c.iqCaller.request(seed(`seed${String(i).padStart(3, '0')}`))
  expect((await reader.items()).length).toBe(limit)

  let refused = 0
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      const id = /^<iq\b[^>]*\bid="([^"]+)"/.exec(frame)?.[1]
      if (id && frame.includes(`<retract node="${NODE}"`)) {
        refused++
        ws.send(`<iq xmlns="jabber:client" type="error" id="${id}"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`)
        return
      }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, first)).toBeVisible({ timeout: 60_000 })
  await savedRow(one, first).getByRole('button', { name: 'Remove from saved' }).click()
  await expect.poll(() => refused, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(savedRow(one, first)).toBeVisible({ timeout: 20_000 }) // restored
  expect((await reader.items()).length).toBe(limit)

  // The refused removal freed nothing: one more save is still refused, and nothing is pushed out.
  const text = `Still one too many ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  const sentBefore = one.frames.length
  await saveMessage(one, text)
  await expect(one.page.getByText(/Saved messages are full/)).toBeVisible()
  await one.page.waitForTimeout(2500)
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  await shot(one.page, 'refused-removal-at-cap')
  const items = await reader.items()
  expect(items.length).toBe(limit)
  expect(items.some(item => item.includes(text))).toBe(false)
  expect(items.some(item => item.includes(first))).toBe(true)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a first limit the server never answers lets the first save create the node and holds every later save back', async ({ browser }) => {
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  let swallow = false // the limit read that follows the node's creation is the one that goes unanswered
  let swallowed = 0
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (swallow && /^<iq\b/.test(frame) && frame.includes('<configure node=')) { swallowed++; return }
      if (frame.includes(`<publish node="${NODE}"`)) swallow = true
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  const first = `Creates the node ${stamp}`
  const second = `Waits for the limit ${stamp}`
  await bob.say('alice', first)
  await bob.say('alice', second)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: second })).toBeVisible({ timeout: 45_000 })
  await saveMessage(one, first)
  await nodeHolds(reader, 1) // the first item of a node that does not exist yet may go: it creates the node
  await expect.poll(() => swallowed, { timeout: 20_000 }).toBeGreaterThan(0)
  const sentBefore = one.frames.length
  await saveMessage(one, second)
  await one.page.waitForTimeout(8000)
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0) // not sent while the limit is unknown
  expect((await reader.items()).length).toBe(1)
  expect(await pendingQueue(one)).toContain(second.slice(0, 12)) // and kept for later
  await shot(one.page, 'first-limit-unreadable')

  // Once the limit can be read, the waiting save goes.
  swallow = false
  kick('alice')
  await reader.stop().catch(() => {})
  reader = await script('alice')
  await nodeHolds(reader, 2)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('logging out with local data cleared removes a save still waiting on this device, and the next account never sends it', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  const readerBob = bob
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Waiting when logging out ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await saveMessage(one, text)
  await expect.poll(() => pendingQueue(one), { timeout: 10_000 }).toContain(text.slice(0, 12))

  // Log out (the server still unreachable, so the waiting save cannot slip out first), asking for the local data to be cleared.
  await one.page.locator('button.p-2:has(svg[class*="vertical"])').first().click() // the options button of the account bar, the first of its kind in the page
  await one.page.getByRole('button', { name: 'Log out', exact: true }).click()
  const clear = one.page.getByRole('checkbox', { name: /Clear local data/ })
  if (!(await clear.isChecked())) await clear.check()
  await one.page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(one.page.locator('#jid')).toBeVisible({ timeout: 30_000 })
  expect(await one.page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved')).length)).toBe(0)
  expect(await one.page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain(text.slice(0, 12))

  // Another account signs in on the same browser: it starts with nothing saved, and nothing of the first account's is sent.
  refuse = false
  const { jid, password } = config!.users.bob
  const sentBefore = one.frames.length
  await one.page.locator('#jid').fill(jid)
  await one.page.locator('input[type=password]').first().fill(password)
  await one.page.getByRole('button', { name: 'Connect' }).click()
  await expect(one.page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  await openSaved(one)
  await expect(one.page.getByTestId('saved-row')).toHaveCount(0)
  await one.page.waitForTimeout(5000)
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  // Read through a fresh session: the first one was ended with the account's other connection.
  const fresh = await script('alice')
  const held = await fresh.items()
  expect(held.some(item => item.includes(text))).toBe(false)
  await fresh.stop()
  await shot(one.page, 'logout-cleared-next-account')
  await emptyNode(reader)
  await one.context.close(); await readerBob.stop(); await reader.stop()
})

test('a saved room message is not continued once a newer saved message was opened instead', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const room = `cancel${stamp}@conference.localhost`
  const text = `Said in the room ${stamp}`
  const chatText = `Said in the chat ${stamp}`
  const BOOKMARKS = 'urn:xmpp:bookmarks:1'
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', 'max'), field('pubsub#send_last_published_item', 'never')))
  const bookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name: 'Proof room', autojoin: 'true' }, xml('nick', {}, 'alice')))), options)))
  const unbookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room })))))

  // The room exists, with one message in it, before the first device joins.
  await bob.c.send(xml('presence', { to: `${room}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await bob.c.send(xml('message', { to: room, type: 'groupchat', id: randomUUID() }, xml('body', {}, text)))
  await bookmark()

  const one = await connect(browser)
  await one.page.getByRole('button', { name: 'Rooms' }).first().click()
  await one.page.getByRole('complementary').getByText('Proof room', { exact: true }).first().click()
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  await saveMessage(one, text)
  await nodeHolds(reader, 1)
  await bob.say('alice', chatText)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: chatText })).toBeVisible({ timeout: 30_000 })
  await saveMessage(one, chatText)
  await nodeHolds(reader, 2)

  // The bookmark goes away: a device that connects now has not joined, and does not list, this room.
  await unbookmark()
  const two = await connect(browser)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await savedRow(two, text).click()
  // The room is shown but not joined, with the join still to come.
  await expect(two.page).toHaveURL(/\/rooms\//)
  await expect(two.page.getByRole('button', { name: 'Join room to participate' })).toBeVisible()
  const roomUrl = two.page.url()
  // A newer open (another saved message) replaces it before the person joins.
  await openSaved(two)
  await expect(savedRow(two, chatText)).toBeVisible()
  await savedRow(two, chatText).click()
  await expect(two.page).not.toHaveURL(/\/rooms\//, { timeout: 30_000 })
  await expect(two.page.locator('.message-highlight').filter({ hasText: chatText })).toBeInViewport({ timeout: 30_000 })
  const chatUrl = two.page.url()
  // The person now joins that room on their own: the abandoned open must not resume (no jump, no highlight).
  // Back through the app's own history, so no page reload clears what the app remembers.
  for (let back = 0; back < 4 && two.page.url() !== roomUrl; back++) { await two.page.goBack(); await two.page.waitForTimeout(500) }
  expect(two.page.url()).toBe(roomUrl)
  await watchTransient(two.page) // from before the join to the end: a highlight that comes and goes would still be recorded
  await two.page.getByRole('button', { name: 'Join room to participate' }).click()
  const join = two.page.getByRole('button', { name: /^Join$/ })
  if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click()
  await expect(two.page.locator('[data-message-body]').filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 })
  await two.page.waitForTimeout(6000)
  expect(two.page.url()).toBe(roomUrl)
  expect(chatUrl).not.toBe(roomUrl)
  const seen = await transient(two.page)
  expect(seen.filter(entry => entry.startsWith('highlight'))).toHaveLength(0) // never highlighted, not even briefly
  expect(seen.filter(entry => entry.startsWith('url') && !entry.includes('/rooms/'))).toHaveLength(0) // never navigated elsewhere
  await expect(two.page.locator('.message-highlight')).toHaveCount(0)
  await shot(two.page, 'room-open-superseded')
  await emptyNode(reader)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})

test('a saved message the archive answers it does not hold says it is no longer available, not that the lookup failed', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const text = `Gone from the archive ${stamp}`
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', '256'), field('pubsub#send_last_published_item', 'never')))
  // An item for a message the archive has never held (the other device saved it, then it disappeared).
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id: `gone${stamp}` }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('delay', { xmlns: 'urn:xmpp:delay', stamp: new Date(Date.now() - 3_600_000).toISOString() }),
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost/x', to: 'alice@localhost', type: 'chat', id: `gone-${stamp}` }, xml('body', {}, text), xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', id: `1700000000000000${stamp.length}`, by: 'alice@localhost' })))))), options)))
  const one = await connect(browser)
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await savedRow(one, text).click()
  // The row's own status, not the opener's toast, which carries the same words.
  await expect(savedRow(one, text).getByRole('status')).toContainText(/no longer available/i, { timeout: 30_000 })
  await expect(savedRow(one, text).getByRole('status')).not.toContainText(/Could not load/i)
  await expect(one.page).toHaveURL(/\/saved/)
  await shot(one.page, 'original-confirmed-gone')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

// Transport injection: the page's own socket answers the redaction republish with the error a server gives a stranger, without forwarding it.
test('a deletion whose redaction the server refuses still shows as deleted, and is applied to the stored copy after a reload', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Deleted but refused ${stamp}`
  const id = await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  let refuse = true
  let refused = 0
  let holdFetch = false
  let heldFetches = 0
  let heldArchive = 0
  let holdArchive = false
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      const iq = /^<iq\b[^>]*\bid="([^"]+)"/.exec(frame)?.[1]
      if (holdFetch && iq && frame.includes(`<items node="${NODE}"`)) { heldFetches++; return }
      if (holdArchive && iq && frame.includes('urn:xmpp:mam:')) { heldArchive++; return } // no archive replay may deliver the deletion either
      if (refuse && iq && frame.includes(`<publish node="${NODE}"`)) {
        refused++
        ws.send(`<iq xmlns="jabber:client" type="error" id="${iq}"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`)
        return
      }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible({ timeout: 45_000 })
  await bob.retract('alice', id)
  await expect.poll(() => refused, { timeout: 20_000 }).toBeGreaterThan(0)
  // The bookmark stays, now as a deleted message; the server still holds the old text, because it refused the redaction.
  await expect(one.page.getByTestId('saved-row')).toHaveCount(1)
  await expect(savedRow(one, 'Message deleted')).toBeVisible()
  expect((await reader.items())[0]).toContain(text)
  await shot(one.page, 'redaction-refused')

  // Allowed again, after a reload that also forgets the durable retraction ledger and holds the saved-node read back:
  // the deletion is then known only from this device's cache, and the stored copy is still the unredacted one.
  refuse = false
  await one.page.evaluate(async () => {
    const names = (await indexedDB.databases()).map(d => d.name).filter((n): n is string => !!n && n.startsWith('fluux-retraction-ledger'))
    for (const name of names) {
      const db: IDBDatabase = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      if (db.objectStoreNames.contains('retractions')) await new Promise<void>((resolve, reject) => { const tx = db.transaction('retractions', 'readwrite'); tx.objectStore('retractions').clear(); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error) })
      db.close()
    }
  })
  const ledger = () => one.page.evaluate(async () => {
    const out: { notedAt: number }[] = []
    for (const { name } of await indexedDB.databases()) {
      if (!name?.startsWith('fluux-retraction-ledger')) continue
      const db: IDBDatabase = await new Promise((resolve, reject) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      if (db.objectStoreNames.contains('retractions')) out.push(...await new Promise<{ notedAt: number }[]>((resolve, reject) => { const q = db.transaction('retractions').objectStore('retractions').getAll(); q.onsuccess = () => resolve(q.result); q.onerror = () => reject(q.error) }))
      db.close()
    }
    return out
  })
  expect(await ledger()).toHaveLength(0) // prerequisite: the durable ledger holds nothing about this deletion
  const receivedBefore = one.received.length
  holdFetch = true
  holdArchive = true // no archive replay may deliver the deletion: only the cache can
  await one.page.reload()
  await expect.poll(() => heldFetches, { timeout: 45_000 }).toBeGreaterThan(0)
  expect(await ledger()).toHaveLength(0) // still nothing in the ledger while the stale copy is outstanding
  expect(one.received.slice(receivedBefore).filter(f => /^<message\b/.test(f) && /retract|moderat/i.test(f))).toHaveLength(0) // and no retraction was replayed to the page
  expect((await reader.items())[0]).toContain(text) // while the server still holds the old copy, about to be fetched
  holdFetch = false
  kick('alice') // the next connection reads the node and receives the unredacted copy
  await reader.stop().catch(() => {})
  const again = await script('alice')
  await openSaved(one)
  await expect(savedRow(one, 'Message deleted')).toBeVisible({ timeout: 60_000 })
  expect(await ledger()).toHaveLength(0) // the deletion was applied from the cache alone, with the ledger and the archive both silent
  expect(heldArchive).toBeGreaterThanOrEqual(0)
  holdArchive = false
  await expect(savedRow(one, text)).toHaveCount(0) // the fetched old copy does not bring its text back
  await expect.poll(async () => (await again.items())[0] ?? '', { timeout: 30_000 }).toContain('deleted="true"')
  expect((await again.items())[0]).not.toContain(text)
  await emptyNode(again)
  await one.context.close(); await bob.stop(); await again.stop()
})

test('a saved message whose archive lookup goes unanswered says the lookup failed, and Try again then reaches the answer of the archive', async ({ browser }) => {
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const text = `Archive silent ${stamp}`
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', '256'), field('pubsub#send_last_published_item', 'never')))
  // An item for a message the archive has never held (the other device saved it, then it disappeared).
  await reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id: `silent${stamp}` }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('delay', { xmlns: 'urn:xmpp:delay', stamp: new Date(Date.now() - 3_600_000).toISOString() }),
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost/x', to: 'alice@localhost', type: 'chat', id: `silent-${stamp}` }, xml('body', {}, text), xml('stanza-id', { xmlns: 'urn:xmpp:sid:0', id: `1700000000000000${stamp.length}`, by: 'alice@localhost' })))))), options)))
  const one = await connect(browser)
  let silent = true
  let swallowed = 0
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (silent && /^<iq\b/.test(frame) && frame.includes('urn:xmpp:mam:2')) { swallowed++; return }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await savedRow(one, text).click()
  // The row's own status, not the opener's toast, which carries the same words.
  await expect(savedRow(one, text).getByRole('status')).toContainText(/Could not load/i, { timeout: 60_000 })
  expect(swallowed).toBeGreaterThan(0)
  await expect(savedRow(one, text).getByRole('status')).not.toContainText(/no longer available/i) // an unanswered lookup never claims the message is gone
  await shot(one.page, 'archive-lookup-unanswered')
  // The archive answers again: Try again reaches its answer.
  silent = false
  await savedRow(one, text).getByRole('button', { name: /Try again/i }).click()
  await expect(savedRow(one, text).getByRole('status')).toContainText(/no longer available/i, { timeout: 30_000 })
  await expect(one.page).toHaveURL(/\/saved/)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

async function logoutOf(client: Client, wipe: boolean) {
  await client.page.locator('button.p-2:has(svg[class*="vertical"])').first().click()
  await client.page.getByRole('button', { name: 'Log out', exact: true }).click()
  const clear = client.page.getByRole('checkbox', { name: /Clear local data/ })
  if ((await clear.isChecked()) !== wipe) await (wipe ? clear.check() : clear.uncheck())
  await client.page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(client.page.locator('#jid')).toBeVisible({ timeout: 30_000 })
}

async function loginAs(client: Client, name: 'alice' | 'bob') {
  const { jid, password } = config!.users[name]
  await client.page.locator('#jid').fill(jid)
  await client.page.locator('input[type=password]').first().fill(password)
  await client.page.getByRole('button', { name: 'Connect' }).click()
  await expect(client.page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
}

const savedKeys = (client: Client) => client.page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('fluux-saved')))

test('switching account keeps the first account\'s waiting save, and a wipe by the second account leaves it alone', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Waiting across accounts ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  let refuse = true
  await one.page.routeWebSocket(/\/ws$/, ws => { if (refuse) void ws.close(); else ws.connectToServer() })
  kick('alice')
  await expect(one.page.getByText(/Reconnecting|Disconnected|Offline/i).first()).toBeVisible({ timeout: 20_000 })
  await saveMessage(one, text)
  await expect.poll(() => pendingQueue(one), { timeout: 10_000 }).toContain(text.slice(0, 12))
  const queueKeys = await savedKeys(one)
  expect(queueKeys.length).toBeGreaterThan(0)

  // Log out without clearing local data, then another account signs in on this browser.
  await logoutOf(one, false)
  expect(await savedKeys(one)).toEqual(queueKeys) // kept
  refuse = false
  const sentBefore = one.frames.length
  await loginAs(one, 'bob')
  await openSaved(one)
  await expect(one.page.getByTestId('saved-row')).toHaveCount(0) // the second account sees nothing of the first
  await one.page.waitForTimeout(5000)
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  expect(await savedKeys(one)).toEqual(expect.arrayContaining(queueKeys)) // and has not touched it

  // The second account logs out and clears its local data: the first account's waiting save stays.
  await logoutOf(one, true)
  expect(await savedKeys(one)).toEqual(expect.arrayContaining(queueKeys))
  await shot(one.page, 'account-switch-queue-kept')

  // The first account returns: its save is sent once.
  const before = one.frames.length
  await loginAs(one, 'alice')
  reader = await script('alice')
  await nodeHolds(reader, 1)
  await one.page.waitForTimeout(5000)
  expect(one.frames.slice(before).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(1)
  expect((await reader.items())[0]).toContain(text)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a full node whose removal goes unanswered stays full: a competing save is not sent, before or after the request deadline', async ({ browser }) => {
  test.setTimeout(300_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const first = `Removal waits at the limit ${stamp}`
  await bob.say('alice', first)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: first })).toBeVisible()
  await saveMessage(one, first)
  await nodeHolds(reader, 1)
  const form = await reader.c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('configure', { node: NODE }))))
  const limit = Number.parseInt(String(form.toString().match(/pubsub#max_items[^]*?<value>([^<]*)<\/value>/)?.[1]), 10)
  const seed = (id: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`))))))))
  for (let i = 0; i < limit - 1; i++) await reader.c.iqCaller.request(seed(`seed${String(i).padStart(3, '0')}`))
  expect((await reader.items()).length).toBe(limit)

  const swallowedAt: number[] = []
  let refuseRemovals = false // the removal is first left unanswered, then refused
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (/^<iq\b/.test(frame) && frame.includes(`<retract node="${NODE}"`)) {
        const id = /\bid="([^"]+)"/.exec(frame)?.[1]
        if (refuseRemovals && id) { ws.send(`<iq xmlns="jabber:client" type="error" id="${id}"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`); return }
        swallowedAt.push(Date.now()); return
      }
      server.send(message)
    })
    server.onMessage(message => ws.send(message))
  })
  await one.page.reload()
  await openSaved(one)
  await expect(savedRow(one, first)).toBeVisible({ timeout: 60_000 })
  await savedRow(one, first).getByRole('button', { name: 'Remove from saved' }).click()
  await expect.poll(() => swallowedAt.length, { timeout: 20_000 }).toBeGreaterThan(0)

  // The removal is unanswered, so nothing is known to be freed: a competing save is not sent, and nothing is evicted.
  const text = `Competes for the freed place ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  const sentBefore = one.frames.length
  await saveMessage(one, text)
  await one.page.waitForTimeout(3000)
  await shot(one.page, 'unanswered-removal-at-cap')
  const noPublish = () => one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))
  expect(noPublish()).toHaveLength(0)
  // Past the request deadline, with the removal sent again and still unanswered, still nothing goes out.
  await expect.poll(() => swallowedAt.length, { timeout: 90_000 }).toBeGreaterThan(1)
  expect(swallowedAt[swallowedAt.length - 1] - swallowedAt[0]).toBeGreaterThanOrEqual(29_000)
  // While the removal is unanswered the competing save waits behind it: queued, not sent.
  expect(await pendingQueue(one)).toContain(text.slice(0, 12))
  expect(noPublish()).toHaveLength(0)
  // Once the removal is refused, the node is known to be full still, and the waiting save is decided: refused as full.
  refuseRemovals = true
  kick('alice') // the reconnect reads the node again and sends what is waiting: the removal first, then the save
  await expect(one.page.getByText(/Your server refused to store this message/).first()).toBeVisible({ timeout: 120_000 }) // the refusal of the waiting save, made when it was sent for
  expect(noPublish()).toHaveLength(0)
  await expect.poll(() => pendingQueue(one), { timeout: 20_000 }).not.toContain(text.slice(0, 12)) // decided, not still waiting
  const items = await reader.items()
  expect(items.length).toBe(limit)
  expect(items.some(item => item.includes(text))).toBe(false)
  expect(items.some(item => item.includes(first))).toBe(true)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a save still being acknowledged when it is removed again is removed from the node once the acknowledgement arrives', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Removed while being stored ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  // The publication reaches the server, but its answer is held back until released.
  let heldId: string | undefined
  let held: string | undefined
  let sendToPage: ((m: string) => void) | undefined
  const retracts: string[] = []
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    sendToPage = m => ws.send(m)
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (/^<iq\b/.test(frame) && frame.includes(`<publish node="${NODE}"`)) heldId ??= /\bid="([^"]+)"/.exec(frame)?.[1]
      if (frame.includes(`<retract node="${NODE}"`)) retracts.push(frame)
      server.send(message)
    })
    server.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (heldId && held === undefined && /^<iq\b/.test(frame) && frame.includes(`id='${heldId}'`) || (heldId && held === undefined && /^<iq\b/.test(frame) && frame.includes(`id="${heldId}"`))) { held = frame; return }
      ws.send(message)
    })
  })
  await one.page.reload()
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 45_000 })
  await saveMessage(one, text)
  await expect.poll(() => held, { timeout: 20_000 }).toBeDefined()
  await nodeHolds(reader, 1) // stored, but the page has not heard so yet
  await openSaved(one)
  await expect(savedRow(one, text)).toBeVisible()
  await savedRow(one, text).getByRole('button', { name: 'Remove from saved' }).click()
  await expect(savedRow(one, text)).toHaveCount(0)
  await one.page.waitForTimeout(2000)
  expect(retracts).toHaveLength(0) // not before the save is acknowledged

  sendToPage!(held!) // the acknowledgement arrives
  await expect.poll(() => retracts.length, { timeout: 20_000 }).toBeGreaterThan(0)
  await nodeHolds(reader, 0)
  await expect(savedRow(one, text)).toHaveCount(0) // and the row never comes back
  await one.page.waitForTimeout(3000)
  await expect(savedRow(one, text)).toHaveCount(0)
  expect(await pendingQueue(one)).not.toContain(text.slice(0, 12))
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a save acknowledged after it was removed again still counts at a full node when its removal goes unanswered and no push announced it, so a competing save is not sent', async ({ browser }) => {
  test.setTimeout(300_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const first = `Fills all but one place ${stamp}`
  await bob.say('alice', first)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: first })).toBeVisible()
  await saveMessage(one, first)
  await nodeHolds(reader, 1)
  const form = await reader.c.iqCaller.request(xml('iq', { type: 'get' }, xml('pubsub', { xmlns: `${PUBSUB}#owner` }, xml('configure', { node: NODE }))))
  const limit = Number.parseInt(String(form.toString().match(/pubsub#max_items[^]*?<value>([^<]*)<\/value>/)?.[1]), 10)
  expect(limit).toBeGreaterThan(2)
  const seed = (id: string) => xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('publish', { node: NODE },
    xml('item', { id }, xml('saved', { xmlns: NODE, stamp: new Date().toISOString() }, xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
      xml('message', { xmlns: 'jabber:client', from: 'bob@localhost', to: 'alice@localhost', type: 'chat', id: `seed-${id}` }, xml('body', {}, `seed ${id}`))))))))
  for (let i = 0; i < limit - 2; i++) await reader.c.iqCaller.request(seed(`seed${String(i).padStart(3, '0')}`))
  expect((await reader.items()).length).toBe(limit - 1) // one place left

  let heldId: string | undefined
  let held: string | undefined
  let sendToPage: ((m: string) => void) | undefined
  let swallowedRetracts = 0
  let swallowedRetractId: string | undefined // the removal is left unanswered, then refused on this same connection under this id
  let dropPushes = true // the node's own change notifications must not tell the page what the acknowledgement alone is meant to
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    sendToPage = m => ws.send(m)
    ws.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      const id = /^<iq\b[^>]*\bid="([^"]+)"/.exec(frame)?.[1]
      if (id && frame.includes(`<publish node="${NODE}"`)) heldId ??= id
      if (id && frame.includes(`<retract node="${NODE}"`)) {
        swallowedRetractId ??= id
        swallowedRetracts++ // unanswered: the row stays removed here, so no visible-list guard can stand in for the count of the server
        return
      }
      server.send(message)
    })
    server.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (dropPushes && /^<message\b/.test(frame) && frame.includes('<event') && frame.includes(NODE)) return
      if (heldId && held === undefined && /^<iq\b/.test(frame) && (frame.includes(`id='${heldId}'`) || frame.includes(`id="${heldId}"`))) { held = frame; return }
      ws.send(message)
    })
  })
  await one.page.reload()
  const second = `Fills the last place ${stamp}`
  await bob.say('alice', second)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: second })).toBeVisible({ timeout: 45_000 })
  await saveMessage(one, second)
  await expect.poll(() => held, { timeout: 20_000 }).toBeDefined()
  await nodeHolds(reader, limit) // stored, the page has not heard so yet
  await openSaved(one)
  await expect(savedRow(one, second)).toBeVisible()
  await savedRow(one, second).getByRole('button', { name: 'Remove from saved' }).click()

  sendToPage!(held!) // the acknowledgement arrives after the removal was asked for; the removal then goes unanswered
  await expect.poll(() => swallowedRetracts, { timeout: 20_000 }).toBeGreaterThan(0)
  await expect(savedRow(one, second)).toHaveCount(0) // still removed here
  await one.page.waitForTimeout(2000)
  // The node is full, whatever the page shows (one visible place is free): a competing save is not sent and nothing is pushed out.
  const third = `Competes for no place ${stamp}`
  await bob.say('alice', third)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: third })).toBeVisible({ timeout: 30_000 })
  const sentBefore = one.frames.length
  await saveMessage(one, third)
  // The save waits behind the unanswered removal (removals go first, one at a time): queued, not sent.
  expect(await pendingQueue(one)).toContain(third.slice(0, 12))
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  // Once the removal is refused the row is back and the node is known to be full: the waiting save is decided: refused by this device without being sent.
  // The outstanding removal is refused on the very connection that sent it: no reconnect, no new read of the node, so the node's content is not read again
  // and the save's decision rests on the count the acknowledgement alone gave.
  const refusal = `<iq xmlns="jabber:client" type="error" id="${swallowedRetractId}"><error type="auth"><forbidden xmlns="urn:ietf:params:xml:ns:xmpp-stanzas"/></error></iq>`
  const readsBefore = one.frames.filter(f => /<items node=/.test(f) && f.includes(NODE)).length
  sendToPage!(refusal)
  await expect(one.page.getByText(/Your server refused to store this message/).first()).toBeVisible({ timeout: 120_000 }) // the refusal of the waiting save, made when it was sent for
  expect(swallowedRetracts).toBe(1) // one removal, never resent: the same connection was kept
  expect(one.frames.filter(f => /<items node=/.test(f) && f.includes(NODE)).length).toBe(readsBefore) // and the node was not read again
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  await expect.poll(() => pendingQueue(one), { timeout: 20_000 }).not.toContain(third.slice(0, 12)) // decided, not still waiting
  await shot(one.page, 'superseded-publish-full-node')
  const items = await reader.items()
  expect(items.length).toBe(limit)
  expect(items.some(item => item.includes(third))).toBe(false)
  expect(items.some(item => item.includes(first))).toBe(true)
  expect(items.some(item => item.includes('seed seed000'))).toBe(true)
  expect(items.some(item => item.includes(second))).toBe(true)
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved-node answer delivered to the first account own read after the account was signed out and cleared brings nothing back', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  let reader = await script('alice')
  await emptyNode(reader)
  const one = await connect(browser)
  const text = `Answered too late ${stamp}`
  await bob.say('alice', text)
  await openChatWith(one, 'Bob')
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible()
  await saveMessage(one, text)
  await nodeHolds(reader, 1)

  // From now on the page's reads of the node are answered by the server, but the answer is held back.
  let hold = false
  let held: string | undefined
  let sendHeld: ((m: string) => void) | undefined // bound to the very connection whose read was held, never to a later one
  await one.page.routeWebSocket(/\/ws$/, ws => {
    const server = ws.connectToServer()
    ws.onMessage(message => {
      server.send(message)
    })
    server.onMessage(message => {
      const frame = typeof message === 'string' ? message : message.toString()
      if (hold && held === undefined && isItemsResult(frame)) { held = frame; sendHeld = m => ws.send(m); return }
      ws.send(message)
    })
  })
  await reader.stop().catch(() => {})
  kick('alice') // the page reconnects under the route, with no answer held yet
  await expect.poll(() => one.received.filter(isItemsResult).length, { timeout: 60_000 }).toBeGreaterThan(0)
  hold = true
  kick('alice') // and reconnects once more: this time the read of the node is answered to nobody
  await expect.poll(() => held, { timeout: 60_000 }).toBeDefined()
  expect(held).toContain(text.slice(0, 12)) // it carries the first account's saved message

  // The answer is given to the read of the first account (on its own connection) while the reads of the local cache that
  // the app then makes are held back: the app has accepted the answer and is partway through handling it when the account is cleared.
  hold = false
  await one.page.evaluate(() => {
    const w = window as unknown as { __idbHold: boolean; __idbQueue: Array<() => void> }
    w.__idbHold = false; w.__idbQueue = []
    const held = new WeakSet<object>()
    for (const proto of [IDBObjectStore.prototype, IDBIndex.prototype] as unknown as Array<Record<string, (...a: unknown[]) => unknown>>) {
      for (const method of ['get', 'getAll', 'getAllKeys', 'count']) {
        const original = proto[method]
        proto[method] = function (this: unknown, ...args: unknown[]) { const request = original.apply(this, args) as object; if (w.__idbHold) held.add(request); return request }
      }
    }
    const add = IDBRequest.prototype.addEventListener
    IDBRequest.prototype.addEventListener = function (this: IDBRequest, type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
      if (type === 'success' && held.has(this)) {
        const call = (event: Event) => (typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event))
        return add.call(this, type, (event: Event) => { if (w.__idbHold) w.__idbQueue.push(() => call(event)); else call(event) }, options)
      }
      return add.call(this, type, listener, options)
    } as typeof IDBRequest.prototype.addEventListener
    w.__idbHold = true
  })
  sendHeld!(held!)
  await expect.poll(() => one.page.evaluate(() => (window as unknown as { __idbQueue: unknown[] }).__idbQueue.length), { timeout: 20_000 }).toBeGreaterThan(0) // the handling of the answer reached the cache and waits there
  const waiting = await one.page.evaluate(() => (window as unknown as { __idbQueue: unknown[] }).__idbQueue.length)
  await logoutOf(one, true)
  expect(await savedKeys(one)).toHaveLength(0)
  // The held cache reads now complete: the handling of the first account's answer resumes after its cleanup.
  const resumed = await one.page.evaluate(() => {
    const w = window as unknown as { __idbHold: boolean; __idbQueue: Array<() => void> }
    w.__idbHold = false
    const queue = w.__idbQueue.splice(0)
    for (const resume of queue) resume()
    return queue.length
  })
  expect(resumed).toBeGreaterThanOrEqual(waiting)
  await one.page.waitForTimeout(3000)
  expect(await savedKeys(one)).toHaveLength(0) // nothing came back into the cleared storage
  await loginAs(one, 'bob')
  await openSaved(one)
  await expect(one.page.getByTestId('saved-row')).toHaveCount(0)
  const sentBefore = one.frames.length
  await one.page.waitForTimeout(3000)
  await expect(one.page.getByTestId('saved-row')).toHaveCount(0)
  await expect(one.page.getByText(text)).toHaveCount(0)
  expect(await one.page.evaluate(() => JSON.stringify(Object.entries(localStorage).filter(([key]) => key.includes('fluux-saved'))))).not.toContain(text.slice(0, 12))
  expect(one.frames.slice(sentBefore).filter(f => f.includes(`<publish node="${NODE}"`))).toHaveLength(0)
  await shot(one.page, 'late-answer-after-switch')
  reader = await script('alice')
  await emptyNode(reader)
  await one.context.close(); await bob.stop(); await reader.stop()
})

test('a saved room message opened but not yet joined is not continued once another account has signed in and joins that room', async ({ browser }) => {
  test.setTimeout(240_000)
  const bob = await script('bob')
  const reader = await script('alice')
  await emptyNode(reader)
  const room = `account${stamp}@conference.localhost`
  const roomName = `Switch room ${stamp}` // unique, so no bookmark left by an earlier run can be picked
  const text = `Said before the switch ${stamp}`
  const BOOKMARKS = 'urn:xmpp:bookmarks:1'
  const field = (name: string, value: string) => xml('field', { var: name }, xml('value', {}, value))
  const options = xml('publish-options', {}, xml('x', { xmlns: 'jabber:x:data', type: 'submit' },
    xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, 'http://jabber.org/protocol/pubsub#publish-options')),
    field('pubsub#persist_items', 'true'), field('pubsub#access_model', 'whitelist'), field('pubsub#max_items', 'max'), field('pubsub#send_last_published_item', 'never')))
  const bookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name: roomName, autojoin: 'true' }, xml('nick', {}, 'alice')))), options)))
  const unbookmark = () => reader.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room })))))
  await bob.c.send(xml('presence', { to: `${room}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })))
  await new Promise(resolve => setTimeout(resolve, 1500))
  await bob.c.send(xml('message', { to: room, type: 'groupchat', id: randomUUID() }, xml('body', {}, text)))
  await bookmark()
  const one = await connect(browser)
  await one.page.getByRole('button', { name: 'Rooms' }).first().click()
  await one.page.getByRole('complementary').getByText(roomName, { exact: true }).first().click()
  await expect(one.page.locator('[data-message-body]').filter({ hasText: text })).toBeVisible({ timeout: 30_000 })
  await saveMessage(one, text)
  await nodeHolds(reader, 1)
  await unbookmark()

  const two = await connect(browser)
  await openSaved(two)
  await expect(savedRow(two, text)).toBeVisible()
  await savedRow(two, text).click()
  await expect(two.page).toHaveURL(/\/rooms\//)
  await expect(two.page.getByRole('button', { name: 'Join room to participate' })).toBeVisible()

  // The account changes while the open waits for a join; the other account then reaches that same room and joins it.
  await two.page.getByRole('button', { name: 'Messages' }).first().click() // the account bar's menu is reached from a list view
  // The other account knows this room but has not joined it.
  await bob.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB },
    xml('publish', { node: BOOKMARKS }, xml('item', { id: room }, xml('conference', { xmlns: BOOKMARKS, name: roomName, autojoin: 'false' }, xml('nick', {}, 'bob')))), options)))
  await logoutOf(two, true)
  await loginAs(two, 'bob')
  await watchTransient(two.page) // from before the join to the end
  await two.page.getByRole('button', { name: 'Rooms' }).first().click()
  await two.page.getByRole('complementary').getByText(roomName, { exact: true }).first().click()
  await expect(two.page.getByRole('button', { name: 'Join room to participate' })).toBeVisible({ timeout: 30_000 })
  await two.page.getByRole('button', { name: 'Join room to participate' }).click()
  const join = two.page.getByRole('button', { name: /^Join$/ })
  if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click()
  await expect(two.page.locator('[data-message-body]').filter({ hasText: text }).first()).toBeVisible({ timeout: 30_000 })
  await two.page.waitForTimeout(6000)
  const seen = await transient(two.page)
  expect(seen.filter(entry => entry.startsWith('highlight'))).toHaveLength(0) // the abandoned open of the first account never resumed
  await expect(two.page.locator('.message-highlight')).toHaveCount(0)
  await shot(two.page, 'room-open-after-account-change')
  await bob.c.iqCaller.request(xml('iq', { type: 'set' }, xml('pubsub', { xmlns: PUBSUB }, xml('retract', { node: BOOKMARKS, notify: 'true' }, xml('item', { id: room }))))).catch(() => {})
  await emptyNode(reader)
  await one.context.close(); await two.context.close(); await bob.stop(); await reader.stop()
})
