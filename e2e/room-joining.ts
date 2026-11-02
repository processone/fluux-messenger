/**
 * FLM-361: joining replaces only the composer; cached history stays readable.
 * Exercise the actual app and MUC.joinRoom; only the demo service response is held.
 * Restored selection is a fixture, not proof of native iOS background/resume.
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'
import { getScrollTop, setScrollTop, waitForAnchorSettled, waitForTopVisibleSettled, wheelUntil } from './harness/scrollHarness'
import { ROOM_JID as TEAM, BOARD_ROOM_JID as BOARD, ENGINEERING_ROOM_JID as EMPTY, DESIGN_ROOM_JID as DESIGN } from '../apps/fluux/src/demo/constants'
type DemoWindow = Window & {
  __demoClient: DemoClient
  __roomStore: typeof roomStore
  __releaseJoin?: () => Promise<void>
  __joinOutcome?: string
  __releaseDiscovery?: () => void
  __reopening?: Promise<void>
  __failedSends?: number
  __releaseOldQueue?: () => void
  __releaseNewQueue?: () => void
}

async function openJoiningRoom(page: Page, jid: string, beforeJoin?: () => Promise<void>) {
  await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(jid)}`)
  await beforeJoin?.()
  await page.evaluate(async ({ jid, team }) => {
    const w = window as unknown as DemoWindow
    const client = w.__demoClient
    const store = w.__roomStore
    client.stopAnimation()
    const nickname = store.getState().getRoom(team)!.nickname
    // Restore an existing room through the real activation/cache boundary.
    // The discoverable Engineering fixture has no cached history to clear.
    if (store.getState().getRoom(jid)) {
      await store.getState().activateRoom(jid)
      store.getState().updateRoom(jid, { joined: false, isJoining: false })
    }

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
    await client.rooms.joinRoom(jid, nickname)
    await store.getState().activateRoom(jid)
    void client.rooms.joinResult(jid).then(
      () => { w.__joinOutcome = 'joined' },
      () => { w.__joinOutcome = 'refused' },
    )
  }, { jid, team: TEAM })
}

// Capture is opt-in, like connection-step.ts: browser screenshots are evidence,
// not part of the repeated join invariant. All UI/state assertions still run.
async function shot(page: Page, info: TestInfo, name: string) {
  if (process.env.ROOM_JOINING_SHOTS === '1' && info.repeatEachIndex === 0) {
    await page.screenshot({ path: info.outputPath(name) })
  }
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

// Assert the actual reading surface, not just the absence of a second join button.
async function expectPendingHistory(page: Page, jid: string) {
  const main = page.getByRole('main')
  const status = main.locator('[data-conversation-tail]').getByRole('status')
  await expect(status).toHaveText('Joining...')
  await expect(status).toHaveAttribute('aria-live', 'polite')
  await expect(status.locator('button, input, textarea, [tabindex]')).toHaveCount(0)
  const bounds = await status.boundingBox()
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
  await expect(main.getByText(/Cached history up to/)).toHaveCount(0)
  await expect(main.getByText('Join to load messages', { exact: true })).toHaveCount(0)
  const observed = await observe(page, jid)
  if (observed.cachedMessages) {
    await expect.poll(() => main.locator('[data-message-id]').evaluateAll(rows => rows.filter(row => {
      const r = row.getBoundingClientRect()
      const v = row.closest('[data-message-list]')!.getBoundingClientRect()
      return r.height > 0 && r.bottom > v.top && r.top < v.bottom
    }).length)).toBeGreaterThan(0)
  } else {
    await expect(main.getByText('No history available yet', { exact: true })).toBeVisible()
    await expect(main.getByText('No messages yet. Say hello!', { exact: true })).toHaveCount(0)
  }
}

for (const [label, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test.describe(`room rejoining (${label})`, () => {
    test.use({ viewport })

    for (const empty of [false, true]) {
      test(`${empty ? 'empty' : 'cached'} room hides join instructions until success`, async ({ page }, info) => {
        const jid = empty ? EMPTY : TEAM
        await openJoiningRoom(page, jid)
        const main = page.getByRole('main')
        await expect(main.getByText('Joining...', { exact: true })).toBeVisible()
        await expect(main.getByRole('button', { name: 'Join room to participate' })).toHaveCount(0)
        await expect(main.getByText(/Cached history up to/)).toHaveCount(0)
        await expect(main.getByText('You are not in this room')).toHaveCount(0)
        await expect(main.getByRole('combobox')).toHaveCount(0)
        await expectPendingHistory(page, jid)
        const joining = await observe(page, jid)
        expect(joining.isJoining).toBe(true)
        expect(joining.joined).toBe(false)
        if (empty) expect(joining.cachedMessages).toBe(0)
        else expect(joining.cachedMessages).toBeGreaterThan(0)
        await shot(page, info, 'joining.png')

        await page.evaluate(() => (window as unknown as DemoWindow).__releaseJoin!())
        await expect.poll(async () => (await observe(page, jid)).joined).toBe(true)
        await expect(main.getByRole('combobox')).toBeVisible()
        await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
        await shot(page, info, 'joined.png')
        await info.attach('join-observations', { body: JSON.stringify({ joining, completed: await observe(page, jid) }, null, 2), contentType: 'application/json' })
      })
    }

    test('FLM-361 keeps the reading anchor and saved draft without stealing focus', async ({ page }, info) => {
      await page.emulateMedia({ reducedMotion: 'reduce' })
      const main = page.getByRole('main')
      const headerControl = main.getByRole('button', { name: /^Show room info: Team Chat/ })
      let anchor: Awaited<ReturnType<typeof waitForTopVisibleSettled>> = null
      await openJoiningRoom(page, TEAM, async () => {
        const composer = main.getByRole('combobox')
        await composer.fill('The regression tests are passing.')
        await expect.poll(() => page.evaluate(jid => (window as unknown as DemoWindow).__roomStore.getState().getDraft(jid), TEAM)).toBe('The regression tests are passing.')
        await setScrollTop(page, 0)
        const start = await getScrollTop(page)
        await wheelUntil(page, 120, () => getScrollTop(page), value => value > start + 20)
        anchor = await waitForTopVisibleSettled(page)
        expect(anchor).not.toBeNull()
        await headerControl.focus()
      })
      await expectPendingHistory(page, TEAM)
      const status = main.locator('[data-conversation-tail]').getByRole('status')
      await expect(status.locator('svg')).toHaveCSS('animation-name', 'none')
      await expect(headerControl).toBeFocused()
      const pendingOffset = await waitForAnchorSettled(page, anchor!.id)
      expect(pendingOffset).not.toBeNull()
      expect(Math.abs(pendingOffset! - anchor!.offsetFromTop)).toBeLessThanOrEqual(20)
      const statusNode = await status.elementHandle()
      await page.evaluate(jid => (window as unknown as DemoWindow).__roomStore.getState().updateRoom(jid, { name: 'Team Chat (joining)' }), TEAM)
      expect(await statusNode!.evaluate(node => node.isConnected)).toBe(true)
      await expect(headerControl).toBeFocused()
      await shot(page, info, 'reading-pending.png')
      await page.evaluate(() => (window as unknown as DemoWindow).__releaseJoin!())
      const composer = main.getByRole('combobox')
      await expect(composer).toBeVisible()
      await expect(composer).toHaveText('The regression tests are passing.')
      await expect(headerControl).toBeFocused()
      const after = await waitForAnchorSettled(page, anchor!.id)
      expect(after).not.toBeNull()
      expect(Math.abs(after! - anchor!.offsetFromTop)).toBeLessThanOrEqual(20)
      await shot(page, info, 'reading-joined.png')
      await info.attach('reading-observations', { body: JSON.stringify({ anchor, pendingOffset, after, focus: await headerControl.evaluate(node => node === document.activeElement) }, null, 2), contentType: 'application/json' })
    })

    test('FLM-361 distinguishes pending empty cache, first history fetch and settled empty', async ({ page }, info) => {
      await openJoiningRoom(page, EMPTY)
      await expectPendingHistory(page, EMPTY)
      await page.evaluate(() => (window as unknown as DemoWindow).__releaseJoin!())
      const main = page.getByRole('main')
      await expect(main.getByRole('combobox')).toBeVisible()
      // Drive the existing SDK history state at its service boundary, not a second UI state.
      await page.evaluate(jid => (window as unknown as DemoWindow).__roomStore.getState().setRoomMAMLoading(jid, true), EMPTY)
      await expect(main.getByText('Loading messages...', { exact: true })).toBeVisible()
      await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
      await shot(page, info, 'first-history.png')
      await page.evaluate(jid => (window as unknown as DemoWindow).__roomStore.getState().setRoomMAMLoading(jid, false), EMPTY)
      await expect(main.getByText('No messages yet. Say hello!', { exact: true })).toBeVisible()
      await shot(page, info, 'settled-empty.png')
    })

    test('G1 releases an abandoned queue without clearing its newer owner', async ({ page }, info) => {
      await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(TEAM)}`)
      await page.evaluate(async jid => {
        const w = window as unknown as DemoWindow
        w.__demoClient.stopAnimation()
        await w.__roomStore.getState().activateRoom(jid)
        w.__roomStore.getState().updateRoom(jid, { joined: false, isJoining: false })
        w.__releaseOldQueue = w.__demoClient.rooms.queueRoomJoin(jid)
        w.__releaseNewQueue = w.__demoClient.rooms.queueRoomJoin(jid)
      }, TEAM)
      const main = page.getByRole('main')
      await expect(main.getByText('Joining...', { exact: true })).toBeVisible()
      await expectPendingHistory(page, TEAM)
      await page.evaluate(() => (window as unknown as DemoWindow).__releaseOldQueue!())
      const newer = await observe(page, TEAM)
      expect(newer.isJoining).toBe(true)
      await expect(main.getByRole('button', { name: 'Join room to participate' })).toHaveCount(0)
      await page.evaluate(() => (window as unknown as DemoWindow).__releaseNewQueue!())
      const join = main.getByRole('button', { name: 'Join room to participate' })
      await expect(join).toBeEnabled()
      await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
      const released = await observe(page, TEAM)
      expect(released.isJoining).toBe(false)
      await shot(page, info, 'queue-released.png')
      await join.click()
      await expect(main.getByRole('combobox')).toBeVisible()
      await info.attach('queue-abort-observations', { body: JSON.stringify({ newer, released, completed: await observe(page, TEAM) }, null, 2), contentType: 'application/json' })
    })

    test('FLM-269 reopen keeps a cached room pending behind delayed discovery', async ({ page }, info) => {
      await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(TEAM)}`)
      await page.evaluate(async ({ selected, first }) => {
        const w = window as unknown as DemoWindow
        const store = w.__roomStore
        const client = w.__demoClient
        client.stopAnimation()
        await store.getState().activateRoom(selected)
        const rooms = [first, selected].map(jid => ({ jid, nickname: store.getState().getRoom(jid)!.nickname }))
        const query = client.rooms.queryRoomFeatures.bind(client.rooms)
        client.rooms.queryRoomFeatures = async jid => {
          if (jid === first) await new Promise<void>(resolve => { w.__releaseDiscovery = resolve })
          return query(jid)
        }
        for (const room of rooms) store.getState().updateRoom(room.jid, { joined: false, isJoining: false })
        w.__reopening = client.rooms.rejoinActiveRooms(rooms)
      }, { selected: TEAM, first: DESIGN })
      const main = page.getByRole('main')
      await expect.poll(() => page.evaluate(() => !!(window as unknown as DemoWindow).__releaseDiscovery)).toBe(true)
      const pending = await page.evaluate(jids => jids.map(jid => {
        const room = (window as unknown as DemoWindow).__roomStore.getState().getRoom(jid)!
        return { jid, joined: room.joined, isJoining: room.isJoining }
      }), [DESIGN, TEAM])
      expect(pending.every(room => !room.joined && room.isJoining)).toBe(true)
      await expect(main.getByText('Joining...', { exact: true })).toBeVisible()
      await expect(main.getByText(/Cached history up to/)).toHaveCount(0)
      await expect(main.getByRole('button', { name: 'Join room to participate' })).toHaveCount(0)
      await expectPendingHistory(page, TEAM)
      const waiting = await observe(page, TEAM)
      await shot(page, info, 'discovery-pending.png')
      await page.evaluate(async () => {
        const w = window as unknown as DemoWindow
        w.__releaseDiscovery!()
        await w.__reopening
      })
      await expect(main.getByRole('combobox')).toBeVisible()
      await info.attach('reopen-observations', { body: JSON.stringify({ pending, waiting, completed: await observe(page, TEAM) }, null, 2), contentType: 'application/json' })
    })

    test('FLM-269 failed presence send restores the join button and retries successfully', async ({ page }, info) => {
      await bootDemo(page, `/demo.html?tutorial=false#/rooms/${encodeURIComponent(TEAM)}`)
      await page.evaluate(async jid => {
        const w = window as unknown as DemoWindow
        w.__demoClient.stopAnimation()
        await w.__roomStore.getState().activateRoom(jid)
        w.__roomStore.getState().updateRoom(jid, { joined: false, isJoining: false })
        const transport = w.__demoClient as unknown as { beginStanzaSend(stanza: { name: string; attrs: { to?: string } }): Promise<void> }
        const send = transport.beginStanzaSend.bind(w.__demoClient)
        transport.beginStanzaSend = async stanza => {
          if (stanza.name === 'presence' && stanza.attrs.to?.startsWith(jid + '/')) {
            transport.beginStanzaSend = send
            w.__failedSends = (w.__failedSends ?? 0) + 1
            throw new Error('Socket not available')
          }
          return send(stanza)
        }
      }, TEAM)
      const main = page.getByRole('main')
      const join = main.getByRole('button', { name: 'Join room to participate' })
      await join.click()
      await expect.poll(() => page.evaluate(() => (window as unknown as DemoWindow).__failedSends)).toBe(1)
      await expect(join).toBeEnabled()
      const failed = await observe(page, TEAM)
      expect(failed.joined).toBe(false)
      expect(failed.isJoining).toBe(false)
      await expect(main.getByText('Joining...', { exact: true })).toHaveCount(0)
      const outcome = await page.evaluate(jid => (window as unknown as DemoWindow).__demoClient.rooms.joinResult(jid).then(() => 'unexpected success', error => error.message), TEAM)
      expect(outcome).toBe('Socket not available')
      await shot(page, info, 'send-failure.png')
      await join.click()
      await expect(main.getByRole('combobox')).toBeVisible()
      await info.attach('send-failure-observations', { body: JSON.stringify({ failed, outcome, completed: await observe(page, TEAM) }, null, 2), contentType: 'application/json' })
    })

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
      await shot(page, info, 'retry.png')
      await retry.click()
      const password = page.getByLabel('Password', { exact: true })
      await expect(password).toBeVisible()
      await password.fill('fluux')
      await shot(page, info, 'password.png')
      await password.press('Enter')
      await expect.poll(async () => (await observe(page, BOARD)).joined).toBe(true)
      await expect(main.getByRole('combobox')).toBeVisible()
      await expect(password).toHaveCount(0)
      await info.attach('retry-observations', { body: JSON.stringify({ failed, completed: await observe(page, BOARD) }, null, 2), contentType: 'application/json' })
    })
  })
}
