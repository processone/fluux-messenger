import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'
import { waitForActions } from './harness/messageInteraction'

// Forwarding one-to-one messages (docs/URL_SCHEMES.md): the sent stanza is read at the SDK's send
// boundary in the real app, because the demo transport drops it. The demo OpenPGP plugin stands in
// for real encryption: it proves what is handed to encrypt and what stays outside it.
type Scope = Window & {
  __demoClient: DemoClient & { e2ee: { getPlugin(id: string): { encrypt(h: unknown, p: Uint8Array): Promise<unknown>; probePeer(p: string): Promise<unknown>; getPeerFingerprint(p: string): string | null } } }
  __sent: string[]
  __encrypted: string[]
}

async function boot(page: Page, hash: string) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, `/demo.html?tutorial=false#${hash}`)
  await page.evaluate(() => {
    const scope = window as unknown as Scope
    scope.__demoClient.stopAnimation()
    scope.__sent = []
    scope.__encrypted = []
    const client = scope.__demoClient as unknown as { beginStanzaSend(s: { name: string; toString(): string }): Promise<void> }
    const original = client.beginStanzaSend.bind(client)
    client.beginStanzaSend = async stanza => { if (stanza.name === 'message') scope.__sent.push(stanza.toString()); return original(stanza) }
    const plugin = scope.__demoClient.e2ee.getPlugin('openpgp')
    const encrypt = plugin.encrypt.bind(plugin)
    plugin.encrypt = async (handle, plaintext) => { scope.__encrypted.push(new TextDecoder().decode(plaintext)); return encrypt(handle, plaintext) }
  })
}

// Chat-state notifications carry no body; only content stanzas count as sent messages.
const sent = (page: Page) => page.evaluate(() => (window as unknown as Scope).__sent.filter(stanza => stanza.includes('<body')))
const encrypted = (page: Page) => page.evaluate(() => (window as unknown as Scope).__encrypted)

async function seedDirect(page: Page, peer: string, id: string, body: string, extra: Record<string, unknown> = {}) {
  await page.evaluate(({ peer, id, body, extra }) => {
    (window as unknown as Scope).__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id, conversationId: peer, from: peer, body, stanzaId: undefined, originId: undefined,
      timestamp: new Date(), isOutgoing: false, ...extra,
    }, isLiveArrival: true } as never)
  }, { peer, id, body, extra })
}

async function openForward(page: Page, peer: string, id: string) {
  await activateChat(page, peer)
  const row = page.locator(`[data-message-id="${id}"][data-message-body]`)
  await row.scrollIntoViewIfNeeded()
  await page.mouse.move(1, 1)
  await page.mouse.move(0, 0)
  await row.hover()
  await waitForActions(page, id)
  await row.getByRole('button', { name: 'Forward message', exact: true }).click()
  return page.getByRole('dialog')
}

async function pickDestination(page: Page, dialog: ReturnType<Page['getByRole']>, query: string, name: RegExp) {
  const input = dialog.getByPlaceholder('Choose a chat or room')
  await input.click()
  await input.clear()
  await input.pressSequentially(query)
  await page.getByTestId('contact-suggestions').getByRole('button', { name }).first().click()
}

test('forward a one-to-one message to another chat: comment, quote and one structured copy', async ({ page }) => {
  await boot(page, '/messages/emma%40fluux.chat')
  await seedDirect(page, 'emma@fluux.chat', 'fwd-src', 'Ship it on Friday')
  const dialog = await openForward(page, 'emma@fluux.chat', 'fwd-src')
  await expect(dialog.getByText('Sends your comment and a quoted copy of the message.', { exact: false })).toBeVisible()
  await pickDestination(page, dialog, 'liam', /liam/i)
  await dialog.getByLabel('Comment (optional)').fill('See this')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toBeHidden()
  const stanzas = await sent(page)
  expect(stanzas).toHaveLength(1)
  const [stanza] = stanzas
  expect(stanza).toContain('to="liam@fluux.chat"')
  expect(stanza).toContain('See this')
  expect(stanza).toContain('Ship it on Friday')
  expect(stanza.match(/<forwarded /g)).toHaveLength(1)
  expect(stanza).toContain('urn:xmpp:fallback:0')
  expect(stanza).not.toContain('?join') // no generated source link: the source has no shared room link
  await page.screenshot({ path: process.env.FORWARD_EVIDENCE ? `${process.env.FORWARD_EVIDENCE}/direct-forward-chat.png` : undefined })
})

test('forward a message that holds a copy: one flattened quote, no nested copy', async ({ page }) => {
  await boot(page, '/messages/emma%40fluux.chat')
  await seedDirect(page, 'emma@fluux.chat', 'fwd-copy', '', {
    forwarded: { author: 'Carol', from: 'carol@example.org', text: 'The copied text', timestamp: Date.now() - 60_000 },
  })
  const dialog = await openForward(page, 'emma@fluux.chat', 'fwd-copy')
  await pickDestination(page, dialog, 'liam', /liam/i)
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toBeHidden()
  const stanzas = await sent(page)
  expect(stanzas).toHaveLength(1)
  const [stanza] = stanzas
  expect(stanza).toContain('Carol')
  expect(stanza).toContain('The copied text')
  const inner = stanza.match(/<forwarded [\s\S]*<\/forwarded>/)![0]
  expect(inner.match(/<forwarded /g)).toHaveLength(1)
  expect(inner).toContain('The copied text')
})

test('forward a one-to-one message to a joined room: comment and quote only', async ({ page }) => {
  await boot(page, '/messages/emma%40fluux.chat')
  await seedDirect(page, 'emma@fluux.chat', 'fwd-room', 'Plain note for the team')
  const dialog = await openForward(page, 'emma@fluux.chat', 'fwd-room')
  await pickDestination(page, dialog, 'team', /team/i)
  await dialog.getByLabel('Comment (optional)').fill('FYI')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toBeHidden()
  const stanzas = await sent(page)
  expect(stanzas).toHaveLength(1)
  const [stanza] = stanzas
  expect(stanza).toContain('type="groupchat"')
  expect(stanza).toContain('FYI')
  expect(stanza).toContain('Plain note for the team')
  expect(stanza).not.toContain('<forwarded')
  expect(stanza).not.toContain('?join')
  await page.screenshot({ path: process.env.FORWARD_EVIDENCE ? `${process.env.FORWARD_EVIDENCE}/forward-direct-to-room.png` : undefined })
})

test('forward from an encrypted chat: no rooms, refused into a plain chat, delivered into an encrypted chat', async ({ page }) => {
  await boot(page, '/messages/ava%40fluux.chat')
  await seedDirect(page, 'ava@fluux.chat', 'fwd-enc', 'Secret roadmap', { securityContext: { protocolId: 'openpgp', trust: 'tofu' } })
  // A second chat that supports encryption, beside emma who has none.
  await page.evaluate(() => {
    const plugin = (window as unknown as Scope).__demoClient.e2ee.getPlugin('openpgp')
    const probe = plugin.probePeer.bind(plugin), fingerprint = plugin.getPeerFingerprint.bind(plugin)
    plugin.probePeer = async peer => peer === 'liam@fluux.chat' ? { supported: true, ttl: 3600, fingerprint: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B3' } : probe(peer)
    plugin.getPeerFingerprint = peer => peer === 'liam@fluux.chat' ? 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B3' : fingerprint(peer)
  })
  let dialog = await openForward(page, 'ava@fluux.chat', 'fwd-enc')
  await expect(dialog.getByText('can only be forwarded into an encrypted chat')).toBeVisible()
  await dialog.getByPlaceholder('Choose a chat or room').pressSequentially('team')
  await expect(page.getByTestId('contact-suggestions').getByRole('button', { name: /team/i })).toHaveCount(0)
  // Into a chat that has no encryption: refused, nothing on the wire.
  await pickDestination(page, dialog, 'emma', /emma/i)
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog.getByRole('alert')).toBeVisible()
  expect(await sent(page)).toEqual([])
  await page.screenshot({ path: process.env.FORWARD_EVIDENCE ? `${process.env.FORWARD_EVIDENCE}/encrypted-forward-refused.png` : undefined })
  await dialog.getByRole('button', { name: 'Cancel' }).click()

  // Into a second encrypted chat: delivered, readable text only inside the encrypted payload.
  dialog = await openForward(page, 'ava@fluux.chat', 'fwd-enc')
  await pickDestination(page, dialog, 'liam', /liam/i)
  await dialog.getByLabel('Comment (optional)').fill('For your eyes')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toBeHidden()
  const stanzas = await sent(page)
  expect(stanzas).toHaveLength(1)
  const [stanza] = stanzas
  const [payload] = await encrypted(page)
  expect(stanza).toContain('urn:xmpp:openpgp:0')
  expect(stanza).not.toContain('Secret roadmap')
  expect(stanza).not.toContain('For your eyes')
  expect(payload).toContain('Secret roadmap')
  expect(payload).toContain('For your eyes')
})

test('an encrypted forward cannot be edited once its destination stops being encrypted', async ({ page }) => {
  await boot(page, '/messages/ava%40fluux.chat')
  await seedDirect(page, 'ava@fluux.chat', 'fwd-edit', 'Secret roadmap', { securityContext: { protocolId: 'openpgp', trust: 'tofu' } })
  await page.evaluate(() => {
    const scope = window as unknown as Scope
    const plugin = scope.__demoClient.e2ee.getPlugin('openpgp') as unknown as { probePeer(p: string): Promise<unknown>; getPeerFingerprint(p: string): string | null; supportsLiam: boolean }
    plugin.supportsLiam = true
    const probe = plugin.probePeer.bind(plugin), fingerprint = plugin.getPeerFingerprint.bind(plugin)
    plugin.probePeer = async peer => peer === 'liam@fluux.chat' && plugin.supportsLiam ? { supported: true, ttl: 3600, fingerprint: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B3' } : probe(peer)
    plugin.getPeerFingerprint = peer => peer === 'liam@fluux.chat' && plugin.supportsLiam ? 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B3' : fingerprint(peer)
  })
  const dialog = await openForward(page, 'ava@fluux.chat', 'fwd-edit')
  await pickDestination(page, dialog, 'liam', /liam/i)
  await dialog.getByLabel('Comment (optional)').fill('First comment')
  await dialog.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await sent(page)).toHaveLength(1)
  // Liam stops supporting encryption; the cached support is dropped as on a new session.
  await page.evaluate(() => {
    const scope = window as unknown as Scope & { __demoClient: { e2ee: { notifyReconnected(i: { resumed: boolean }): void } } }
    ;(scope.__demoClient.e2ee.getPlugin('openpgp') as unknown as { supportsLiam: boolean }).supportsLiam = false
    scope.__demoClient.e2ee.notifyReconnected({ resumed: false })
  })
  await activateChat(page, 'liam@fluux.chat')
  const row = page.locator('[data-message-body]').filter({ hasText: 'First comment' }).last()
  await row.scrollIntoViewIfNeeded()
  await row.hover()
  await row.getByRole('button', { name: 'Edit message', exact: true }).click()
  const editor = page.getByRole('combobox', { name: 'Message Liam Brooks' })
  await editor.press('ControlOrMeta+End')
  await editor.pressSequentially(' edited')
  await editor.press('Enter')
  await expect(page.getByText(/Encryption is required|isn't available/).first()).toBeVisible()
  expect(await sent(page)).toHaveLength(1)
  await page.screenshot({ path: process.env.FORWARD_EVIDENCE ? `${process.env.FORWARD_EVIDENCE}/encrypted-forward-retry-edit.png` : undefined })
})
