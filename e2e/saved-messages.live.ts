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

interface Client { page: Page; context: BrowserContext; frames: string[] }

async function connect(browser: Browser, name: 'alice' | 'bob' = 'alice'): Promise<Client> {
  const { jid, password } = config!.users[name]
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  const page = await context.newPage()
  const frames: string[] = []
  page.on('websocket', ws => ws.on('framesent', frame => { if (typeof frame.payload === 'string') frames.push(frame.payload) }))
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await page.goto('/')
  await page.locator('#jid').fill(jid)
  await page.locator('input[type=password]').first().fill(password)
  await page.keyboard.press('Control+,')
  await page.locator('#server').fill(config!.ws)
  await page.getByText('Remember me').click()
  await page.getByRole('button', { name: 'Connect' }).click()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 })
  return { page, context, frames }
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

async function openChatWith(client: Client, peer: string) {
  const { page } = client
  await page.getByRole('button', { name: 'Messages' }).first().click()
  await page.getByRole('complementary').getByText(peer, { exact: true }).first().click()
  await expect(page.getByRole('combobox', { name: /^Message / })).toBeVisible()
}

async function saveMessage(client: Client, text: string) {
  const row = client.page.locator('[data-message-body]').filter({ hasText: text }).last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await row.getByRole('button', { name: 'More options', exact: true }).click()
  await row.getByRole('button', { name: 'Save message', exact: true }).click()
}

async function openSaved(client: Client) {
  await client.page.getByRole('link', { name: 'Saved', exact: true }).or(client.page.getByRole('button', { name: 'Saved', exact: true })).first().click()
  await expect(client.page).toHaveURL(/\/saved/)
  await client.page.mouse.move(700, 500) // the pointer leaves the rail, so no tooltip covers the page
}

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
  await two.page.getByRole('button', { name: 'Join room to participate' }).click()
  const join = two.page.getByRole('button', { name: /^Join$/ })
  if (await join.isVisible({ timeout: 3000 }).catch(() => false)) await join.click()
  await expect(two.page.locator('.message-highlight').filter({ hasText: text })).toBeInViewport({ timeout: 30_000 })
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
