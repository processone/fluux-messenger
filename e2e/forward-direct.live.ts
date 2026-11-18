import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'

// Live proof of one-to-one forwarding with real OpenPGP (the web plugin, openpgp.js) against a disposable
// local XMPP server. Every account runs the real app in its own browser context; the frames each page sends
// over its WebSocket are recorded, so a test can assert on every stanza that leaves, not only the first.
//
//   FLUUX_LIVE_APP=http://127.0.0.1:5391 FLUUX_LIVE_ACCOUNTS=/path/accounts.json FLUUX_LIVE_EVIDENCE=/path/dir \
//     npx playwright test --config e2e/playwright.live.config.ts
// accounts.json: { "ws": "ws://127.0.0.1:45280/ws", "users": { "alice": { "jid": "...", "password": "..." }, ... },
//                  "unregisterCarol": "<shell command that deletes carol's account>" }
const accountsFile = process.env.FLUUX_LIVE_ACCOUNTS
test.skip(!accountsFile, 'FLUUX_LIVE_ACCOUNTS is not set')
const config = accountsFile ? JSON.parse(readFileSync(accountsFile, 'utf8')) as {
  ws: string; users: Record<string, { jid: string; password: string }>; unregisterCarol: string; unregisterBob: string
} : null
const PASSPHRASE = 'correct horse battery staple'
const evidence = process.env.FLUUX_LIVE_EVIDENCE

interface Client { page: Page; context: BrowserContext; frames: string[]; jid: string }

async function connect(browser: Browser, name: string, options: { openpgp: boolean }): Promise<Client> {
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
  await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible({ timeout: 30_000 })
  if (options.openpgp) {
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByRole('button', { name: 'Encryption' }).click()
    await page.getByRole('switch').first().click()
    const fields = page.locator('input[type=password]')
    await fields.nth(0).fill(PASSPHRASE)
    await fields.nth(1).fill(PASSPHRASE)
    await page.getByRole('button', { name: 'Set up', exact: true }).click()
    await expect(page.getByText('Your key is ready and published.')).toBeVisible({ timeout: 60_000 })
  }
  await page.getByRole('button', { name: 'Messages' }).first().click()
  return { page, context, frames, jid }
}

/** Message stanzas this page has sent, in order, with chat-state notifications left out. */
const messagesSent = (client: Client) => client.frames.filter(frame => frame.startsWith('<message') && frame.includes('<body'))

async function openChat(client: Client, peer: string) {
  const { page } = client
  const composer = page.getByRole('combobox', { name: /^Message / })
  const name = peer
  const existing = page.getByRole('complementary').getByRole('button', { name: new RegExp(`^${name.charAt(0).toUpperCase()}?\\s*${name}\\b`, 'i') })
  await page.getByRole('button', { name: 'Messages' }).first().click()
  if (await existing.count()) await existing.first().click()
  else {
    // A contact with no conversation yet: start one from the contact list.
    await page.getByRole('button', { name: /^Contacts/ }).click()
    await page.getByText(name, { exact: true }).first().dblclick()
  }
  await expect(composer).toBeVisible()
  await expect(composer).toHaveAccessibleName(new RegExp(name, 'i'))
}

async function say(client: Client, peer: string, text: string) {
  await openChat(client, peer)
  const composer = client.page.getByRole('combobox', { name: /^Message / })
  await composer.click()
  await composer.pressSequentially(text)
  await composer.press('Enter')
  await expect(client.page.locator('[data-message-body]').filter({ hasText: text }).last()).toBeVisible()
}

async function openForward(client: Client, text: string) {
  const row = client.page.locator('[data-message-body]').filter({ hasText: text }).last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await row.getByRole('button', { name: 'Forward message', exact: true }).click()
  return client.page.getByRole('dialog')
}

async function pick(client: Client, dialog: ReturnType<Page['getByRole']>, query: string, name: RegExp) {
  const input = dialog.getByPlaceholder('Choose a chat or room')
  await input.click()
  await input.clear()
  await input.pressSequentially(query)
  await client.page.getByTestId('contact-suggestions').getByRole('button', { name }).first().click()
}

const shot = (page: Page, name: string) => page.screenshot({ path: evidence ? `${evidence}/live-${name}.png` : undefined })
const sentSince = (client: Client, count: number) => messagesSent(client).slice(count)

async function joinTeamRoom(client: Client) {
  const { page } = client
  await page.getByRole('button', { name: 'Rooms' }).click()
  await page.getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByText(/^Join room/i).first().click()
  await page.getByLabel('Room Address').fill('team@conference.localhost')
  await page.getByRole('button', { name: 'Join room', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Join Room' })).toBeHidden({ timeout: 20_000 })
}

async function openRoom(client: Client) {
  await client.page.getByRole('button', { name: 'Rooms' }).click()
  await client.page.getByText('team', { exact: true }).first().click()
  await expect(client.page.getByRole('combobox', { name: /^Message / })).toBeVisible()
}

test('one-to-one forwarding against a real server with real OpenPGP', async ({ browser }) => {
  test.setTimeout(900_000)
  const alice = await connect(browser, 'alice', { openpgp: true })
  const bob = await connect(browser, 'bob', { openpgp: true })
  const carol = await connect(browser, 'carol', { openpgp: true })
  const dave = await connect(browser, 'dave', { openpgp: false })
  const erin = await connect(browser, 'erin', { openpgp: false })

  await test.step('plain forward: comment, quote and one structured copy; a plain recipient shows the copy', async () => {
    await say(dave, 'alice', 'Ship it on Friday')
    await openChat(alice, 'dave')
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'Ship it on Friday' })).toBeVisible()
    const before = messagesSent(alice).length
    const dialog = await openForward(alice, 'Ship it on Friday')
    await pick(alice, dialog, 'erin', /erin/)
    await dialog.getByLabel('Comment (optional)').fill('See this')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    const sent = sentSince(alice, before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('to="erin@localhost')
    expect(sent[0].match(/<forwarded /g)).toHaveLength(1)
    expect(sent[0]).toContain('urn:xmpp:fallback:0')
    expect(sent[0]).not.toContain('?join')
    await openChat(erin, 'alice')
    const received = erin.page.locator('[data-message-body]').filter({ hasText: 'See this' })
    await expect(received).toBeVisible()
    await expect(received).toContainText('Forwarded message from')
    await expect(received).toContainText('Ship it on Friday')
    await expect(received).not.toContainText('wrote:')
    await shot(erin.page, 'plain-forward-recipient')
  })

  await test.step('flatten: forwarding a message that holds a comment and a copy sends one readable quote', async () => {
    const before = messagesSent(erin).length
    const dialog = await openForward(erin, 'See this')
    await pick(erin, dialog, 'dave', /dave/)
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    const sent = sentSince(erin, before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('Ship it on Friday')
    expect(sent[0]).toContain('See this')
    expect(sent[0].match(/<forwarded /g)).toHaveLength(1)
    await openChat(dave, 'erin')
    const received = dave.page.locator('[data-message-body]').filter({ hasText: 'Ship it on Friday' }).last()
    await expect(received).toBeVisible()
    await shot(dave.page, 'flatten-recipient')
  })

  await joinTeamRoom(alice)
  await joinTeamRoom(carol)

  await test.step('plain forward into a joined room: comment and quote only; the member shows them', async () => {
    await openChat(alice, 'dave')
    const before = messagesSent(alice).length
    const dialog = await openForward(alice, 'Ship it on Friday')
    await pick(alice, dialog, 'team', /team/)
    await dialog.getByLabel('Comment (optional)').fill('For the room')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    const sent = sentSince(alice, before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('type="groupchat"')
    expect(sent[0]).toContain('For the room')
    expect(sent[0]).toContain('Ship it on Friday')
    expect(sent[0]).not.toContain('<forwarded')
    expect(sent[0]).not.toContain('?join')
    await openRoom(carol)
    const received = carol.page.locator('[data-message-body]').filter({ hasText: 'For the room' })
    await expect(received).toBeVisible()
    await expect(received).toContainText('Ship it on Friday')
    await shot(carol.page, 'room-forward-recipient')
  })

  await test.step('encrypted source into an encrypted chat is delivered; the recipient decrypts it', async () => {
    await say(bob, 'alice', 'Secret roadmap')
    await openChat(alice, 'bob')
    const row = alice.page.locator('[data-message-body]').filter({ hasText: 'Secret roadmap' })
    await expect(row).toBeVisible()
    const before = messagesSent(alice).length
    const dialog = await openForward(alice, 'Secret roadmap')
    await expect(dialog.getByText('can only be forwarded into an encrypted chat')).toBeVisible()
    // The room is not offered for an encrypted source.
    await dialog.getByPlaceholder('Choose a chat or room').click()
    await dialog.getByPlaceholder('Choose a chat or room').pressSequentially('team')
    await expect(alice.page.getByTestId('contact-suggestions').getByRole('button', { name: /team/ })).toHaveCount(0)
    await pick(alice, dialog, 'carol', /carol/)
    await dialog.getByLabel('Comment (optional)').fill('For your eyes')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    const sent = sentSince(alice, before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('urn:xmpp:openpgp:0')
    expect(sent[0]).not.toContain('Secret roadmap')
    expect(sent[0]).not.toContain('For your eyes')
    expect(sent[0]).not.toContain('<forwarded')
    await openChat(carol, 'alice')
    const received = carol.page.locator('[data-message-body]').filter({ hasText: 'For your eyes' })
    await expect(received).toBeVisible()
    await expect(received).toContainText('Secret roadmap')
    await shot(carol.page, 'encrypted-forward-recipient')
  })

  await test.step('encrypted source into a chat without encryption is refused with nothing sent', async () => {
    await openChat(alice, 'bob')
    const before = messagesSent(alice).length
    const dialog = await openForward(alice, 'Secret roadmap')
    await pick(alice, dialog, 'erin', /erin/)
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog.getByRole('alert')).toBeVisible()
    expect(sentSince(alice, before)).toHaveLength(0)
    // Close the suggestion list so nothing covers the alert.
    await dialog.getByRole('heading', { name: 'Forward message' }).click()
    await expect(alice.page.getByTestId('contact-suggestions')).toHaveCount(0)
    await shot(alice.page, 'encrypted-forward-refused')
    await dialog.getByRole('button', { name: 'Cancel' }).click()
    await openChat(erin, 'alice')
    await expect(erin.page.getByText('Secret roadmap')).toHaveCount(0)
  })

  await test.step('a protected forward back to its sender is delivered, as a row to edit later', async () => {
    await openChat(alice, 'bob')
    const before = messagesSent(alice).length
    const dialog = await openForward(alice, 'Secret roadmap')
    await pick(alice, dialog, 'bob', /bob/)
    await dialog.getByLabel('Comment (optional)').fill('For bob')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    const sent = sentSince(alice, before)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('urn:xmpp:openpgp:0')
    expect(sent[0]).not.toContain('For bob')
    await expect(alice.page.locator('[data-message-body]').filter({ hasText: 'For bob' })).toBeVisible()
  })

  await test.step('a protected forward the server refuses is marked failed', async () => {
    // Carol blocks alice, so the server answers alice's next message with an error.
    await carol.page.getByRole('button', { name: /^Contacts/ }).click()
    await carol.page.getByText('alice', { exact: true }).first().click()
    await carol.page.getByRole('button', { name: /actions/i }).last().click()
    await carol.page.getByText('Block user').click()
    await carol.page.getByRole('button', { name: 'Block', exact: true }).click()
    const before = messagesSent(alice).length
    await openChat(alice, 'bob')
    const dialog = await openForward(alice, 'Secret roadmap')
    await pick(alice, dialog, 'carol', /carol/)
    await dialog.getByLabel('Comment (optional)').fill('Second try')
    await dialog.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(sentSince(alice, before)).toHaveLength(1)
    await openChat(alice, 'carol')
    await alice.page.waitForTimeout(2000)
    await shot(alice.page, 'failed-forward')
  })

  await test.step('after carol leaves and alice reloads, Retry and Edit of protected forwards are refused', async () => {
    execSync(config!.unregisterCarol)
    await alice.page.reload()
    // The session passphrase was lost with the page: unlock the key again.
    await alice.page.getByRole('button', { name: 'Unlock', exact: true }).first().waitFor()
    await alice.page.locator('input[type=password]').first().fill(PASSPHRASE)
    await alice.page.getByRole('button', { name: 'Unlock', exact: true }).last().click()
    await expect(alice.page.getByText('Unlock End-to-End Encryption')).toBeHidden()
    // The reload keeps the open conversation with carol, restored from the local cache.
    await expect(alice.page.getByRole('combobox', { name: /^Message / })).toHaveAccessibleName(/carol/i)
    const refusal = alice.page.getByText(/Message not sent\. Encryption/).first()
    // Retry of the failed protected forward: refused, nothing sent, the failure stays.
    const retried = alice.frames.length
    const failedRow = alice.page.locator('[data-message-body]').filter({ hasText: 'Second try' }).last()
    await failedRow.getByRole('button', { name: 'Retry' }).click()
    await expect(refusal).toBeVisible()
    await alice.page.waitForTimeout(500)
    await shot(alice.page, 'retry-refused')
    expect(alice.frames.slice(retried).filter(frame => frame.startsWith('<message') && frame.includes('<body'))).toHaveLength(0)
    await expect(failedRow.getByRole('button', { name: 'Retry' })).toBeVisible()
    // Edit of a restored protected forward: refused, nothing sent.
    await openChat(alice, 'bob')
    const edited = alice.frames.length
    const restored = alice.page.locator('[data-message-body]').filter({ hasText: 'For bob' }).last()
    await restored.scrollIntoViewIfNeeded()
    await restored.hover()
    await restored.getByRole('button', { name: 'Edit message', exact: true }).click()
    const editor = alice.page.getByRole('combobox', { name: /^Message / })
    await editor.press('ControlOrMeta+End')
    await editor.pressSequentially(' edited')
    await editor.press('Enter')
    await alice.page.waitForTimeout(1500)
    await shot(alice.page, 'edit-restored-encrypted')
    // The restored protected forward is corrected in protected form: one stanza, no plaintext.
    const corrections = alice.frames.slice(edited).filter(frame => frame.startsWith('<message') && frame.includes('<body'))
    expect(corrections).toHaveLength(1)
    expect(corrections[0]).toContain('urn:xmpp:openpgp:0')
    expect(corrections[0]).toContain('urn:xmpp:message-correct:0')
    expect(corrections[0]).toContain('[OpenPGP-encrypted message]')
    expect(corrections[0]).not.toContain('edited')
    expect(corrections[0]).not.toContain('For bob')
  })

  await bob.context.close(); await dave.context.close(); await erin.context.close(); await carol.context.close(); await alice.context.close()
})
