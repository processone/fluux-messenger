import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

// xmpp: link actions (docs/URL_SCHEMES.md): links inside a message act in the app
// and never send or join for the person. Demo history is the fixture.
const PEER = 'emma@fluux.chat'
const EVIDENCE = process.env.XMPP_LINK_EVIDENCE_DIR

// Links wait for the app to be online and its roster loaded, which a loaded machine can delay.
test.use({ actionTimeout: 30_000 })
test.beforeEach(() => { test.setTimeout(240_000) })
const patient = { timeout: 30_000 }

async function receiveLink(page: Page, id: string, uri: string) {
  await page.evaluate(({ id, uri, peer }) => {
    const scope = window as unknown as { __demoClient: DemoClient }
    scope.__demoClient.emitSDK('chat:message', { message: {
      type: 'chat', id, conversationId: peer, from: peer, body: uri,
      stanzaId: undefined, originId: undefined, timestamp: new Date(), isOutgoing: false,
    }, isLiveArrival: true })
  }, { id, uri, peer: PEER })
  const link = page.locator(`[data-message-id="${id}"][data-message-body]`).getByRole('link', { name: uri, exact: true })
  await expect(link).toBeVisible()
  return link
}

async function shot(page: Page, name: string) {
  if (EVIDENCE) await page.screenshot({ path: `${EVIDENCE}/${name}.png` })
}

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false#/messages')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await activateChat(page, PEER)
}

const scenarios = () => {
  test('a subscribe link opens Add contact with the address filled in and sends nothing', async ({ page }) => {
    await boot(page)
    const link = await receiveLink(page, 'link-subscribe', 'xmpp:stranger@example.net?subscribe')
    await link.click()
    await expect(page.getByRole('heading', { name: 'Add contact' })).toBeVisible(patient)
    await expect(page.getByLabel('JID (Jabber ID)')).toHaveValue('stranger@example.net', patient)
    await shot(page, `subscribe-${test.info().project.name}`)
  })

  test('a message link to a room opens it with Join, unjoined, with the text kept as its draft', async ({ page }) => {
    await boot(page)
    const link = await receiveLink(page, 'link-room', 'xmpp:fresh@conference.example.net?message;body=See%20you%20there')
    await link.click()
    await expect(page.getByRole('button', { name: /Join room/ })).toBeVisible(patient)
    const state = await page.evaluate(() => {
      const scope = window as unknown as { __roomStore: typeof roomStore }
      const s = scope.__roomStore.getState()
      return { joined: s.rooms.get('fresh@conference.example.net')?.joined, draft: s.getDraft('fresh@conference.example.net') }
    })
    expect(state).toEqual({ joined: false, draft: 'See you there' })
    await shot(page, `room-message-${test.info().project.name}`)
  })

  test('a message link with text fills the composer below the draft, once, and sends nothing', async ({ page }) => {
    await boot(page)
    const composer = page.getByPlaceholder('Message Emma Wilson', { exact: true })
    await composer.fill('See you at 6')
    const link = await receiveLink(page, 'link-body', 'xmpp:emma@fluux.chat?message;body=Hi')
    await link.click()
    await expect(composer).toHaveValue(/Hi$/, patient)
    await link.click()
    await expect(composer).toHaveValue('See you at 6\n\nHi', patient)
    await shot(page, `body-draft-${test.info().project.name}`)
  })
}

test.describe('xmpp: link actions, desktop', scenarios)

test.describe('xmpp: link actions, phone width', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
  scenarios()
})
