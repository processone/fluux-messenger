/**
 * FLM-269: reopening an already-joining room must not offer a second join.
 * Exercise the actual app and MUC.joinRoom; only the demo service response is held.
 * Restored selection is a fixture, not proof of native iOS background/resume.
 */
import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

const TEAM = 'team@conference.fluux.chat'
const BOARD = 'board@conference.fluux.chat'
type DemoWindow = Window & {
  __demoClient: DemoClient
  __roomStore: typeof roomStore
  __releaseJoin?: () => Promise<void>
  __joinOutcome?: string
}

async function openJoiningRoom(page: Page, jid: string, empty = false) {
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(jid)}`)
  await page.evaluate(async ({ jid, empty }) => {
    const w = window as unknown as DemoWindow
    const client = w.__demoClient
    const store = w.__roomStore
    client.stopAnimation()
    // Restore the selected room through the real activation/cache boundary.
    await store.getState().activateRoom(jid)
    if (empty) store.setState(state => ({ messages: new Map(state.messages).set(jid, []) }))
    store.getState().updateRoom(jid, { joined: false, isJoining: false })

    // Hold only the simulated service's first response, not the SDK state machine.
    const transport = client as unknown as { beginStanzaSend(stanza: { name: string; attrs: { to?: string } }): Promise<void> }
    const send = transport.beginStanzaSend.bind(client)
    transport.beginStanzaSend = async stanza => {
      if (stanza.name === 'presence' && stanza.attrs.to?.startsWith(`${jid}/`)) {
        w.__releaseJoin = () => {
          transport.beginStanzaSend = send
          return send(stanza)
        }
        return
      }
      return send(stanza)
    }
    await client.rooms.joinRoom(jid, store.getState().getRoom(jid)!.nickname)
    void client.rooms.joinResult(jid).then(
      () => { w.__joinOutcome = 'joined' },
      () => { w.__joinOutcome = 'refused' },
    )
  }, { jid, empty })
}

async function observe(page: Page, jid: string) {
  return page.evaluate(jid => {
    const w = window as unknown as DemoWindow
    const room = w.__roomStore.getState().getRoom(jid)!
    return {
      joined: room.joined,
      isJoining: room.isJoining,
      cachedMessages: w.__roomStore.getState().activeMessages().length,
      outcome: w.__joinOutcome,
      visibleRoom: document.querySelector('main')?.textContent,
    }
  }, jid)
}

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(`room rejoining (${label})`, () => {
    test.use({ viewport })

    for (const empty of [false, true]) {
      test(`${empty ? 'empty' : 'cached'} room hides join instructions until success`, async ({ page }, info) => {
        await openJoiningRoom(page, TEAM, empty)
        const main = page.getByRole('main')
        await expect(main.getByText('Joining...', { exact: true })).toBeVisible()
        await expect(main.getByRole('button', { name: 'Join room to participate' })).toHaveCount(0)
        await expect(main.getByText(/Cached history up to/)).toHaveCount(0)
        await expect(main.getByText('You are not in this room')).toHaveCount(0)
        await expect(main.getByRole('textbox')).toHaveCount(0)
        const joining = await observe(page, TEAM)
        expect(joining.isJoining).toBe(true)
        expect(joining.joined).toBe(false)
        if (empty) expect(joining.cachedMessages).toBe(0)
        else expect(joining.cachedMessages).toBeGreaterThan(0)
        if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('joining.png') })

        await page.evaluate(() => (window as unknown as DemoWindow).__releaseJoin!())
        await expect.poll(async () => (await observe(page, TEAM)).joined).toBe(true)
        await expect(main.getByRole('textbox')).toBeVisible()
        await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
        if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('joined.png') })
        await info.attach('join-observations', { body: JSON.stringify({ joining, completed: await observe(page, TEAM) }, null, 2), contentType: 'application/json' })
      })
    }

    test('a refused join restores the prompt and password retry still works', async ({ page }, info) => {
      await openJoiningRoom(page, BOARD)
      const main = page.getByRole('main')
      await expect(main.getByRole('button', { name: 'Join room to participate' })).toHaveCount(0)
      await page.evaluate(() => (window as unknown as DemoWindow).__releaseJoin!())
      await expect.poll(async () => (await observe(page, BOARD)).outcome).toBe('refused')
      const retry = main.getByRole('button', { name: 'Join room to participate' })
      await expect(retry).toBeEnabled()
      await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
      await expect(main.getByText(/Cached history up to/)).toBeVisible()
      const failed = await observe(page, BOARD)
      if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('retry.png') })
      await retry.click()
      const password = page.getByRole('textbox', { name: 'Room password' })
      await expect(password).toBeVisible()
      await password.fill('fluux')
      if (info.repeatEachIndex === 0) await page.screenshot({ path: info.outputPath('password.png') })
      await password.press('Enter')
      await expect.poll(async () => (await observe(page, BOARD)).joined).toBe(true)
      await expect(main.getByRole('textbox')).toBeVisible()
      await expect(password).toHaveCount(0)
      await info.attach('retry-observations', { body: JSON.stringify({ failed, completed: await observe(page, BOARD) }, null, 2), contentType: 'application/json' })
    })
  })
}
