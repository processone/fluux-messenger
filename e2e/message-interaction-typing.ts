import { expect, test, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import { arrive, distance, jidFor, keepJson, readInteractionReadState, setupInteraction, stableFrames, waitForActions, TARGET, type ConversationKind } from './harness/messageInteraction'
import { waitForTopVisibleSettled, wheelAwayFromBottom } from './harness/scrollHarness'

// Intent: the accepted press/focus policy must clear measured typing space without following arrivals.
async function typing(page: Page, kind: ConversationKind, state: 'one' | 'two' | 'off') {
  await page.evaluate(({ kind, jid, state }) => {
    const client = (window as unknown as { __demoClient: DemoClient }).__demoClient
    const name = state === 'two' ? 'Emmanuelle Catherine Wilson – International infrastructure coordination' : 'Emma Wilson'
    if (kind === 'chat') {
      client.emitSDK('contacts:contact-updated', { jid, updates: { name } })
      client.emitSDK('chat:typing', { conversationId: jid, jid, isTyping: state !== 'off' })
    } else {
      client.emitSDK('room:typing', { roomJid: jid, nick: 'Adrien', isTyping: state === 'one' })
      client.emitSDK('room:typing', { roomJid: jid, nick: 'Emmanuelle Catherine Wilson – International infrastructure coordination', isTyping: state === 'two' })
    }
  }, { kind, jid: jidFor(kind), state })
  await expect(page.locator('[data-typing-pill]')).toHaveCount(state === 'off' ? 0 : 1)
}

async function geometry(page: Page, id: string) {
  return page.locator('[data-message-list]').evaluate((list, id) => {
    const row = list.querySelector(`.message-row[data-message-id="${CSS.escape(id)}"]`)!
    const control = row.querySelector('[aria-label="Reply"]')!
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
    const { row, list } = await setupInteraction(page, kind, false, virtualized)
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
    await target.locator('[data-msg-text]').hover()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await waitForActions(page, id)
    const passiveBefore = await geometry(page, id)
    await typing(page, kind, 'one')
    await stableFrames(page, id)
    const passiveTyping = await geometry(page, id)
    expect(passiveTyping.held).toBeNull()
    if (history) expect(passiveTyping.rowTop).toBeCloseTo(passiveBefore.rowTop, 0)
    else expect(passiveTyping.tailBottom!).toBeLessThanOrEqual(passiveTyping.viewBottom + 1)
    await typing(page, kind, 'off')
    await stableFrames(page, id)
    await target.locator('[data-msg-text]').hover()
    await waitForActions(page, id)
    const reply = target.getByRole('button', { name: 'Reply', exact: true })
    await reply.hover()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    await page.keyboard.press('Shift')
    await reply.focus()
    await expect(list).toHaveAttribute('data-message-interaction', await target.getAttribute('data-message-row-id') as string)
    await stableFrames(page, id)
    const before = await geometry(page, id)
    await typing(page, kind, 'one')
    await stableFrames(page, id)
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
    await Promise.all([typing(page, kind, 'two'), arrive(page, kind, ['typing-simultaneous-arrival'])])
    await stableFrames(page, id)
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
    await typing(page, kind, 'off')
    await stableFrames(page, id)
    const stopped = await geometry(page, id)
    expect(stopped.band).toBe(0)
    expect(stopped.rowTop).toBeCloseTo(before.rowTop, 0)
    await page.locator('textarea.message-input, .message-input[contenteditable="true"]').last().focus()
    await expect(list).not.toHaveAttribute('data-message-interaction')
    if (history) expect(await distance(page)).toBeGreaterThan(100)
    else await expect.poll(() => distance(page)).toBeLessThanOrEqual(1)
    await keepJson('typing-clearance', { kind, virtualized, history, id, passiveBefore, passiveTyping, before, one, two, stopped, read, finalDistance: await distance(page) })
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
    await page.keyboard.press('Shift')
    await row.getByRole('button', { name: 'Reply', exact: true }).focus()
    const before = await geometry(page, TARGET)
    await page.setViewportSize({ width: 800, height: 400 })
    await typing(page, kind, alreadyTyping ? 'one' : 'two')
    await stableFrames(page, TARGET)
    const cramped = await geometry(page, TARGET)
    expect(cramped.held).toBe(before.held)
    expect(cramped.controlTop).toBeGreaterThanOrEqual(cramped.viewTop - 1)
    expect(cramped.controlBottom).toBeLessThanOrEqual(cramped.viewBottom + 1)
    expect(cramped.tailBottom!).toBeGreaterThan(cramped.viewBottom)
    await expect(list).toHaveAttribute('data-message-interaction')
    await keepJson('cramped-typing-clearance', { before, cramped })
  })
}
