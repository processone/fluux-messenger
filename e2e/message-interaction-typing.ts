import { expect, test, type Page, type Locator } from '@playwright/test'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { DemoClient } from '@fluux/sdk/demo'
import { arrive, distance, keepJson, readInteractionReadState, setupInteraction, stableFrames, waitForActions, TARGET, ACTION_LINK_BODY, restoreMessageActionFocus, tabOutOfMessageActions, setInteractionTyping as typing, sampleInteractionLayout, expectTypingClearance } from './harness/messageInteraction'
import { waitForTopVisibleSettled, wheelAwayFromBottom } from './harness/scrollHarness'

type InteractionStores = Window & { __chatStore: typeof chatStore; __roomStore: typeof roomStore; __demoClient: DemoClient }

// Intent: the accepted press/focus policy must clear measured typing space without following arrivals.
async function geometry(page: Page, id: string) {
  return page.locator('[data-message-list]').evaluate((list, id) => {
    const row = list.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`)!
    const control = row.querySelector('[aria-label="More options"]')!
    const tail = list.querySelector('.message-row[data-message-id="typing-tail"]')
    const view = list.getBoundingClientRect()
    const box = control.getBoundingClientRect()
    return { top: list.scrollTop, height: list.clientHeight, held: list.getAttribute('data-message-interaction'),
      rowTop: row.getBoundingClientRect().top, controlTop: box.top, controlBottom: box.bottom,
      tailBottom: tail?.getBoundingClientRect().bottom ?? null, viewTop: view.top, viewBottom: view.bottom,
      band: list.parentElement!.querySelector('[data-typing-band]')!.getBoundingClientRect().height }
  }, id)
}

for (const kind of ['chat', 'room'] as const) for (const virtualized of [false, true]) for (const history of [false, true]) {
  test(`${kind} ${virtualized ? 'virtualized' : 'plain'} ${history ? 'history' : 'latest'}: typing clears focused actions without chasing arrivals`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { row, list } = await setupInteraction(page, kind, false, virtualized, ACTION_LINK_BODY)
    await arrive(page, kind, ['typing-tail'])
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    let target = row
    if (history) {
      await wheelAwayFromBottom(page, 160, -360)
      expect(await waitForTopVisibleSettled(page)).not.toBeNull()
      const id = await list.evaluate(list => {
        const view = list.getBoundingClientRect()
        return [...list.querySelectorAll<HTMLElement>('.message-row[data-message-id]')].find(row => {
          const box = row.getBoundingClientRect()
          return box.top > view.top + 90 && box.bottom < view.bottom - 90
        })!.dataset.messageId!
      })
      target = page.locator(`.message-row[data-message-id="${id}"]`)
    }
    const id = await target.getAttribute('data-message-id') as string
    await list.click({ position: { x: 5, y: 5 } })
    const composer = page.locator('textarea.message-input, .message-input[contenteditable="true"]').last()
    await expect(composer).not.toBeFocused()
    await target.locator('[data-msg-text]').hover()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await waitForActions(page, id)
    const passiveBefore = await geometry(page, id)
    const passiveStates = []
    for (const state of ['one', 'two', 'off'] as const) {
      const frames = await sampleInteractionLayout(page, { row: target,
        control: target.getByRole('button', { name: 'More options', exact: true }),
        tail: history ? undefined : page.locator('.message-row[data-message-id="typing-tail"]') }, async () => {
        await typing(page, kind, state)
        await stableFrames(page, id)
      })
      await keepJson(`passive-${state}-frames`, frames)
      await expect(composer).not.toBeFocused()
      // Passive hover keeps ordinary following animation; held actions alone require per-frame clearance.
      for (const frame of frames) expect(frame.held).toBeNull()
      const settled = await geometry(page, id)
      expect(settled.held).toBeNull()
      if (history) expect(settled.rowTop).toBeCloseTo(passiveBefore.rowTop, 0)
      else expect(settled.tailBottom!).toBeLessThanOrEqual(settled.viewBottom + 1)
      passiveStates.push({ state, frames, geometry: settled })
    }
    expect(passiveStates[0].geometry.band).toBeGreaterThan(0)
    expect(passiveStates[1].geometry.band).toBeGreaterThan(passiveStates[0].geometry.band)
    expect(passiveStates[2].geometry.band).toBe(0)
    await target.locator('[data-msg-text]').hover()
    await waitForActions(page, id)
    const more = target.getByRole('button', { name: 'More options', exact: true })
    await more.hover()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await restoreMessageActionFocus(page, target)
    await expect(list).toHaveAttribute('data-message-interaction', await target.getAttribute('data-message-row-id') as string)
    await stableFrames(page, id)
    const before = await geometry(page, id)
    const oneFrames = await sampleInteractionLayout(page, { row: target, control: more, tail: history ? undefined : page.locator('.message-row[data-message-id="typing-tail"]') }, async () => {
      await typing(page, kind, 'one')
      await stableFrames(page, id)
    })
    await keepJson('typing-start-frames', oneFrames)
    expectTypingClearance(oneFrames, !history, id)
    const one = await geometry(page, id)
    await keepJson('typing-first-clearance', { before, one })
    expect(one.band).toBeGreaterThan(0)
    expect(one.controlTop).toBeGreaterThanOrEqual(one.viewTop - 1)
    expect(one.controlBottom).toBeLessThanOrEqual(one.viewBottom + 1)
    if (history) expect(Math.abs(one.rowTop - before.rowTop)).toBeLessThanOrEqual(1)
    else {
      expect(one.tailBottom).not.toBeNull()
      expect(one.tailBottom!).toBeLessThanOrEqual(one.viewBottom + 1)
      expect(one.top - before.top).toBeCloseTo(Math.max(0, before.tailBottom! - one.viewBottom), 0)
    }
    const twoFrames = await sampleInteractionLayout(page, { row: target, control: more, tail: history ? undefined : page.locator('.message-row[data-message-id="typing-tail"]') }, async () => {
      await Promise.all([typing(page, kind, 'two'), arrive(page, kind, ['typing-simultaneous-arrival'])])
      await stableFrames(page, id)
    })
    await keepJson('typing-wrap-frames', twoFrames)
    expectTypingClearance(twoFrames, !history, id)
    const two = await geometry(page, id)
    expect(two.band).toBeGreaterThan(one.band)
    expect(two.controlTop).toBeGreaterThanOrEqual(two.viewTop - 1)
    expect(two.controlBottom).toBeLessThanOrEqual(two.viewBottom + 1)
    expect(two.held).toBe(before.held)
    const read = await readInteractionReadState(page, kind)
    expect(read.readId).not.toBe(read.lastId)
    expect(read.unread).toBeGreaterThan(0)
    if (history) expect(Math.abs(two.rowTop - before.rowTop)).toBeLessThanOrEqual(1)
    else expect(two.tailBottom!).toBeLessThanOrEqual(two.viewBottom + 1)
    const heldTop = two.top
    await arrive(page, kind, ['typing-later-arrival'])
    await stableFrames(page, id)
    expect((await geometry(page, id)).top).toBeCloseTo(heldTop, 0)
    const stopFrames = await sampleInteractionLayout(page, { row: target, control: more, tail: history ? undefined : page.locator('.message-row[data-message-id="typing-tail"]') }, async () => {
      await typing(page, kind, 'off')
      await stableFrames(page, id)
    })
    await keepJson('typing-stop-frames', stopFrames)
    expectTypingClearance(stopFrames, !history, id)
    const stopped = await geometry(page, id)
    expect(stopped.band).toBe(0)
    expect(stopped.rowTop).toBeCloseTo(before.rowTop, 0)
    await tabOutOfMessageActions(page)
    await expect(list).not.toHaveAttribute('data-message-interaction')
    if (history) expect(await distance(page)).toBeGreaterThan(100)
    else await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await keepJson('typing-clearance', { kind, virtualized, history, id, passiveBefore, passiveStates, before, one, two, stopped, oneFrames, twoFrames, stopFrames, read, finalDistance: await distance(page) })
  })
}

for (const kind of ['chat', 'room'] as const) for (const alreadyTyping of [false, true]) {
  test(`${kind}: a cramped typing viewport prioritizes the focused action over the old tail (already typing: ${alreadyTyping})`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { row, list } = await setupInteraction(page, kind)
    await arrive(page, kind, ['typing-tail'])
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    if (alreadyTyping) {
      await typing(page, kind, 'one')
      await stableFrames(page, TARGET)
    }
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page)
    await restoreMessageActionFocus(page, row)
    const before = await geometry(page, TARGET)
    await page.setViewportSize({ width: 800, height: 400 })
    await stableFrames(page, TARGET)
    const frames = await sampleInteractionLayout(page, {
      row, control: row.getByRole('button', { name: 'More options', exact: true }),
      tail: page.locator('.message-row[data-message-id="typing-tail"]'),
    }, async () => {
      await typing(page, kind, alreadyTyping ? 'one' : 'two')
      await stableFrames(page, TARGET)
    })
    await keepJson('cramped-typing-frames', frames)
    expect(frames.some(frame => frame.bandHeight > 0)).toBe(true)
    expectTypingClearance(frames.filter(frame => frame.bandHeight > 0), false, (await row.getAttribute('data-message-row-id'))!)
    const cramped = await geometry(page, TARGET)
    expect(cramped.held).toBe(before.held)
    expect(cramped.controlTop).toBeGreaterThanOrEqual(cramped.viewTop - 1)
    expect(cramped.controlBottom).toBeLessThanOrEqual(cramped.viewBottom + 1)
    expect(cramped.tailBottom!).toBeGreaterThan(cramped.viewBottom)
    await expect(list).toHaveAttribute('data-message-interaction')
    await keepJson('cramped-typing-clearance', { before, cramped })
  })
}

async function observePressedPointerEvents(button: Locator) {
  await button.evaluate(control => {
      const scope = window as Window & { __pressedPointerEvents?: unknown[] }
      scope.__pressedPointerEvents = []
      let pointerId = -1
      for (const type of ['pointerdown', 'gotpointercapture', 'pointermove', 'pointerout', 'pointerup', 'lostpointercapture', 'mousedown', 'mousemove', 'mouseup', 'click']) {
        document.addEventListener(type, event => {
          const pointer = event as PointerEvent
          if (type === 'pointerdown') pointerId = pointer.pointerId
          scope.__pressedPointerEvents!.push({ type, pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY,
            buttons: pointer.buttons, trusted: event.isTrusted, capture: pointerId >= 0 && control.hasPointerCapture(pointerId),
            held: document.querySelector('[data-message-list]')?.getAttribute('data-message-interaction'),
            target: event.target instanceof Element ? event.target.getAttribute('aria-label') : null })
        }, true)
      }
    })
}

async function pressedPointerEvents(page: Page) {
  return page.evaluate(() => (window as Window & { __pressedPointerEvents?: unknown[] }).__pressedPointerEvents)
}

async function observeMessageActionClicks(page: Page) {
    await page.evaluate(() => {
      const scope = window as Window & { __pressedMessageClicks?: { id: string | null; label: string | null; trusted: boolean }[] }
      scope.__pressedMessageClicks = []
      document.addEventListener('click', event => {
        const button = event.composedPath().find(node => node instanceof HTMLButtonElement) as HTMLButtonElement | undefined
        const row = event.target instanceof Element ? event.target.closest('[data-message-row-id]') : null
        if (button && row) scope.__pressedMessageClicks!.push({ id: row.getAttribute('data-message-id'), label: button.getAttribute('aria-label'), trusted: event.isTrusted })
      }, true)
    })
}

const pressedActions = [
  { name: 'Reply', result: 'reply' },
  { name: 'More options', result: 'more' },
  { name: 'React with 👍', result: 'reaction' },
] as const

for (const kind of ['chat', 'room'] as const) for (const virtualized of [false, true]) for (const action of pressedActions) {
  test(`${kind} ${virtualized ? 'virtualized' : 'plain'}: typing preserves the native ${action.result} press`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { row, list } = await setupInteraction(page, kind, false, virtualized, ACTION_LINK_BODY)
    await arrive(page, kind, ['typing-tail'])
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page)
    const button = row.getByRole('button', { name: action.name, exact: true })
    await observeMessageActionClicks(page)
    await observePressedPointerEvents(button)
    await button.hover()
    await page.mouse.down()
    await expect(list).toHaveAttribute('data-message-interaction')
    const before = await button.boundingBox()
    const frames = await sampleInteractionLayout(page, { row, control: button, tail: page.locator('.message-row[data-message-id="typing-tail"]') }, async () => {
      await typing(page, kind, 'one')
      await stableFrames(page, TARGET)
      await Promise.all([typing(page, kind, 'two'), arrive(page, kind, ['pressed-typing-arrival'])])
      await stableFrames(page, TARGET)
    })
    const shifted = await button.boundingBox()
    await keepJson('pressed-layout-before-release', { frames, before, shifted })
    expectTypingClearance(frames, true, (await row.getAttribute('data-message-row-id'))!)
    for (const frame of frames) expect(frame.toolbarOpacity, 'the pressed action must remain visible through clearance').toBe(1)
    expect(frames.some(frame => frame.bandHeight > 0)).toBe(true)
    expect(before!.y - shifted!.y, 'the fixture must move the pressed button beyond its old hit area').toBeGreaterThan(before!.height)
    await page.mouse.up()
    await keepJson('pressed-pointer-events', await pressedPointerEvents(page))
    const clicks = await page.evaluate(() => (window as Window & { __pressedMessageClicks?: unknown[] }).__pressedMessageClicks)
    expect(clicks).toEqual([{ id: TARGET, label: action.name, trusted: true }])
    if (action.result === 'reply') await expect(page.locator('[data-conversation-tail]').getByText(ACTION_LINK_BODY, { exact: true })).toBeVisible()
    else if (action.result === 'more') await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
    else await expect.poll(() => page.evaluate(({ kind, id }) => {
      const scope = window as unknown as InteractionStores
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const state = kind === 'chat' ? scope.__chatStore.getState() : scope.__roomStore.getState()
      return state.messages.get(jid)?.find(message => message.id === id)?.reactions?.['👍']?.length ?? 0
    }, { kind, id: TARGET })).toBe(1)
    await keepJson('native-press-through-typing', { kind, virtualized, action, before, shifted, frames, clicks })
  })
}

for (const kind of ['chat', 'room'] as const) for (const virtualized of [false, true]) for (const cancellation of ['departure', 'wheel', 'escape', 'retraction', 'pointercancel'] as const) {
  test(`${kind} ${virtualized ? 'virtualized' : 'plain'}: ${cancellation} cancels the original press after typing clearance`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { row, list } = await setupInteraction(page, kind, false, virtualized, ACTION_LINK_BODY)
    await arrive(page, kind, ['typing-tail'])
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page)
    const more = row.getByRole('button', { name: 'More options', exact: true })
    await observeMessageActionClicks(page)
    await observePressedPointerEvents(more)
    await more.hover()
    await page.mouse.down()
    await expect(list).toHaveAttribute('data-message-interaction')
    await typing(page, kind, 'two')
    await stableFrames(page, TARGET)
    if (cancellation === 'departure') await page.mouse.move(0, 0)
    else if (cancellation === 'wheel') await page.mouse.wheel(0, -100)
    else if (cancellation === 'escape') await page.keyboard.press('Escape')
    else if (cancellation === 'pointercancel') {
      const pointerId = await page.evaluate(() => {
        const events = (window as Window & { __pressedPointerEvents?: { type: string; pointerId?: number }[] }).__pressedPointerEvents
        const id = events?.find(event => event.type === 'pointerdown')?.pointerId
        if (typeof id !== 'number') throw new Error('The real press did not provide a pointer identity')
        return id
      })
      await more.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, button: 0 })
      await page.mouse.move(0, 0)
    }
    else await page.evaluate(async kind => {
      const scope = window as unknown as InteractionStores
      const jid = kind === 'chat' ? 'emma@fluux.chat' : 'team@conference.fluux.chat'
      const state = kind === 'chat' ? scope.__chatStore.getState() : scope.__roomStore.getState()
      await state.updateMessage(jid, 'interaction-target', { isRetracted: true, body: '' })
    }, kind)
    await keepJson('cancellation-pointer-events', await pressedPointerEvents(page))
    await expect(list).not.toHaveAttribute('data-message-interaction')
    if (cancellation === 'pointercancel') {
      try { await expect(row.locator('[data-message-toolbar]')).toHaveCSS('opacity', '0') }
      finally { await page.screenshot({ path: test.info().outputPath('pointer-cancellation.png') }) }
    }
    await page.mouse.up()
    await expect(page.locator('[data-message-panel]')).toHaveCount(0)
    const clicks = await page.evaluate(() => (window as Window & { __pressedMessageClicks?: unknown[] }).__pressedMessageClicks)
    expect(clicks).toEqual([])
    await keepJson('cancelled-press-after-typing', { kind, virtualized, cancellation, clicks, distance: await distance(page) })
  })
}

for (const virtualized of [false, true]) {
  test(`room ${virtualized ? 'virtualized' : 'plain'}: typing clears the exact tail occurrence sharing a handle`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { list } = await setupInteraction(page, 'room', false, virtualized)
    const duplicate = async (body: string) => page.evaluate(body => {
      const scope = window as unknown as InteractionStores
      const instant = new Date()
      const roomJid = 'team@conference.fluux.chat'
      scope.__demoClient.emitSDK('room:message', { roomJid, message: {
        id: 'reissued-tail', roomJid, from: `${roomJid}/Adrien`, nick: 'Adrien', type: 'groupchat',
        body, timestamp: instant, receivedAt: instant, isOutgoing: false,
        stanzaId: undefined, originId: undefined, occupantId: undefined,
      }, isLiveArrival: true, incrementUnread: true })
    }, body)
    await duplicate('The earlier checklist is ready for review.')
    await expect(page.locator('.message-row[data-message-id="reissued-tail"]')).toHaveCount(1)
    await arrive(page, 'room', ['duplicate-control'], true, ACTION_LINK_BODY)
    const row = page.locator('.message-row[data-message-id="duplicate-control"]')
    await expect(row).toBeVisible()
    await duplicate('The latest checklist is ready for review.')
    const duplicates = page.locator('.message-row[data-message-id="reissued-tail"]')
    await expect(duplicates).toHaveCount(2)
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    expect(await duplicates.evaluateAll(rows => new Set(rows.map(row => row.getAttribute('data-message-row-id'))).size)).toBe(1)
    const tail = duplicates.last()
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page, 'duplicate-control')
    await row.getByRole('button', { name: 'Reply', exact: true }).hover()
    await page.mouse.down()
    const frames = await sampleInteractionLayout(page, { row, control: row.getByRole('button', { name: 'Reply', exact: true }), tail }, async () => {
      for (const state of ['one', 'two', 'off'] as const) {
        await typing(page, 'room', state)
        await stableFrames(page, 'duplicate-control')
      }
    })
    await keepJson('duplicate-room-tail-typing', { virtualized, frames })
    expectTypingClearance(frames, true, (await row.getAttribute('data-message-row-id'))!)
    await expect(list).toHaveAttribute('data-message-interaction')
    await page.mouse.up()
  })
}

for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: an oversized picker clears its shadow-focused search through typing transitions`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 900 })
    const { row } = await setupInteraction(page, kind)
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page)
    await row.getByRole('button', { name: 'More reactions', exact: true }).click()
    const panel = row.locator('[data-message-panel="reactions"]')
    const search = row.locator('em-emoji-picker').getByRole('searchbox')
    await expect(search).toBeFocused()
    await page.setViewportSize({ width: 800, height: 520 })
    await stableFrames(page, TARGET)
    expect((await panel.boundingBox())!.height).toBeGreaterThan(await page.locator('[data-message-list]').evaluate(element => element.clientHeight))
    const initialControl = (await search.boundingBox())!
    const initialTail = (await row.boundingBox())!
    const frames = await sampleInteractionLayout(page, { row, control: search, tail: row, panel }, async () => {
      for (const state of ['one', 'two', 'off'] as const) {
        await typing(page, kind, state)
        await stableFrames(page, TARGET)
      }
    })
    await keepJson('oversized-picker-shadow-focus', { kind, initialControl, initialTail, frames })
    expectTypingClearance(frames, true, (await row.getAttribute('data-message-row-id'))!)
    for (const frame of frames) {
      expect(initialTail.y + initialTail.height - initialControl.y).toBeGreaterThan(frame.viewport.height)
      const needed = Math.max(0, initialControl.y + initialControl.height - frame.viewport.bottom)
      expect(Math.abs(frame.control.top - (initialControl.y - needed)), 'only the focused control may require correction when the full panel cannot fit').toBeLessThanOrEqual(1)
    }
    await expect(search).toBeFocused()
  })
}

for (const virtualized of [false, true]) {
  test(`room ${virtualized ? 'virtualized' : 'plain'}: archive enrichment keeps the original tail through typing wrap`, async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 })
    const { row, list } = await setupInteraction(page, 'room', false, virtualized)
    const body = 'The captured checklist remains the last visible message.'
    await arrive(page, 'room', ['enriched-tail'], false, body)
    const tail = page.locator('.message-row[data-message-id="enriched-tail"]')
    await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await row.locator('[data-msg-text]').hover()
    await waitForActions(page)
    const more = row.getByRole('button', { name: 'More options', exact: true })
    await more.hover()
    await page.mouse.down()
    await expect(list).toHaveAttribute('data-message-interaction')
    const originalKey = await tail.getAttribute('data-message-row-key')
    const frames = await sampleInteractionLayout(page, { row, control: more, tail, tailText: body }, async () => {
      await typing(page, 'room', 'one')
      await stableFrames(page, TARGET)
      await arrive(page, 'room', ['newer-than-enriched-tail'])
      await page.evaluate(async () => {
        const state = (window as unknown as InteractionStores).__roomStore.getState()
        const jid = 'team@conference.fluux.chat'
        const captured = state.messages.get(jid)?.find(message => message.id === 'enriched-tail')
        if (!captured) throw new Error('The captured tail left the room fixture')
        await state.updateMessage(jid, captured.id, { stanzaId: 'archive-enriched-tail',
          receivedAt: captured.receivedAt ?? captured.timestamp,
          timestamp: new Date(captured.timestamp.getTime() + 1),
          localRowRef: { id: captured.id, occupantId: captured.occupantId, originId: captured.originId } })
      })
      await expect(tail).toHaveAttribute('data-stanza-id', 'archive-enriched-tail')
      await typing(page, 'room', 'two')
      await stableFrames(page, TARGET)
      await typing(page, 'room', 'off')
      await stableFrames(page, TARGET)
    })
    await keepJson('enriched-original-tail-frames', { virtualized, originalKey, currentKey: await tail.getAttribute('data-message-row-key'), frames })
    expectTypingClearance(frames, true, (await row.getAttribute('data-message-row-id'))!)
    const read = await readInteractionReadState(page, 'room')
    expect(read.readId).not.toBe(read.lastId)
    await page.mouse.up()
    await expect(row.locator('[data-message-panel="more"]')).toBeVisible()
  })
}
