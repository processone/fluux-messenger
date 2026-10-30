// Intent: FLM-256 — Enter, click and Enter must not resend a pending draft,
// even when settings navigation remounts the conversation (FLM-255).
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

const BODY = 'Et il y a aussi ce nouveau ticket dolya: https://ejabberd.atlassian.net/browse/EJABS-4575'
const PEER = 'emma@fluux.chat'

async function openChat(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const w = window as any
    const client = w.__demoClient
    client.stopAnimation()
    client.messages.sendChatState = async () => {}
    w.__sendProbe = { calls: [], options: [], settled: false }
    const original = client.messages.sendMessage.bind(client.messages)
    client.messages.sendMessage = async (...args: unknown[]) => {
      w.__sendProbe.calls.push(args[1])
      w.__sendProbe.options.push(args[2])
      await new Promise<void>((resolve, reject) => {
        w.__sendProbe.complete = resolve
        w.__sendProbe.fail = () => reject(new Error('Socket not available'))
      })
      const result = await original(...args)
      w.__sendProbe.settled = true
      return result
    }
  })
  await activateChat(page, PEER)
  // The demo initially opens Ava. Wait for the requested recipient's actual
  // composer, not merely any visible textarea while routing is still pending.
  const field = page.getByPlaceholder('Message Emma Wilson', { exact: true })
  await expect(field).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__chatStore.getState().activeConversationId)).toBe(PEER)
  return field
}

async function openRoom(page: Page) {
  await openChat(page)
  await page.locator('[data-nav="rooms"]').click()
  await page.getByText('Team Chat', { exact: true }).first().click()
  const editor = page.locator('.message-input[contenteditable="true"]').first()
  await expect(editor).toBeVisible()
  return editor
}

async function captureState(page: Page) {
  if (process.env.FLUUX_COMPOSER_PROOF) {
    await page.screenshot({ path: test.info().outputPath('recovery-state.png'), animations: 'disabled' })
  }
}

async function calls(page: Page) {
  return page.evaluate(() => (window as any).__sendProbe.calls.length)
}

for (const remount of [false, true]) {
  test(`pending Enter cannot resend${remount ? ' after remount' : ''}`, async ({ page }) => {
    const field = await openChat(page)
    await field.fill(BODY)
    // Observe actual persisted draft rather than relying on a debounce sleep.
    await expect.poll(() => page.evaluate(peer => (window as any).__chatStore.getState().getDraft(peer), PEER)).toBe(BODY)
    await field.press('Enter')
    await expect.poll(() => calls(page)).toBe(1)
    if (remount) {
      await page.evaluate(() => { location.hash = '#/settings' })
      await expect(field).toHaveCount(0)
      await page.evaluate(peer => { location.hash = `#/messages/${encodeURIComponent(peer)}` }, PEER)
      await expect(field).toBeVisible()
    }
    await field.click()
    await field.press('Enter')
    const during = { text: await field.inputValue(), calls: await calls(page) }
    console.log(JSON.stringify({ remount, during }))
    expect(during.text).toBe('')
    expect(during.calls).toBe(1)
    await page.evaluate(() => (window as any).__sendProbe.complete())
    await expect.poll(() => page.evaluate(() => (window as any).__sendProbe.settled)).toBe(true)
    await field.click()
    await field.press('Enter')
    console.log(JSON.stringify({ remount, during, afterText: await field.inputValue(), calls: await calls(page) }))
    expect(await calls(page)).toBe(1)
    await expect(page.locator('[data-message-body]').filter({ hasText: BODY })).toHaveCount(1)
  })
}

test('failed send restores text with a visible error', async ({ page }) => {
  const field = await openChat(page)
  await field.fill(BODY)
  await field.press('Enter')
  await expect.poll(() => calls(page)).toBe(1)
  await page.evaluate(() => (window as any).__sendProbe.fail())
  await expect(field).toHaveValue(BODY)
  await expect(page.getByText(/^Failed to send( message)?$/)).toBeVisible()
  await captureState(page)
  await expect(page.getByText('Failed to send message', { exact: true })).toBeVisible()
  console.log(JSON.stringify({ recoveredText: await field.inputValue(), calls: await calls(page), error: 'Failed to send message' }))
  // Retrying after a reported failure is a deliberate new send, not a second
  // Enter on a still-pending message. The demo failure did not deliver a row.
  await field.press('Enter')
  await expect.poll(() => calls(page)).toBe(2)
  await page.evaluate(() => (window as any).__sendProbe.complete())
  await expect(page.locator('[data-message-body]').filter({ hasText: BODY })).toHaveCount(1)
  await expect(field).toHaveValue('')
})

// The next draft belongs to the user, not to the first send's completion.
test('successful pending send preserves the next draft', async ({ page }) => {
  const field = await openChat(page)
  await field.fill(BODY)
  await field.press('Enter')
  await expect.poll(() => calls(page)).toBe(1)
  await field.fill('Oups')
  await expect.poll(() => page.evaluate(peer => (window as any).__chatStore.getState().getDraft(peer), PEER)).toBe('Oups')
  await page.evaluate(() => (window as any).__sendProbe.complete())
  await expect(page.locator('[data-message-body]').filter({ hasText: BODY })).toHaveCount(1)
  await expect(field).toHaveValue('Oups')
  expect(await page.evaluate(peer => (window as any).__chatStore.getState().getDraft(peer), PEER)).toBe('Oups')
  console.log(JSON.stringify({ nextDraft: await field.inputValue(), calls: await calls(page) }))
})

// W1/W2: the captain selected keeping failed text as a draft and restoring the
// live box after remount; no newer input may be discarded to make room for it.
for (const remount of [false, true]) {
  for (const newer of ['', 'Oups']) {
    test(`failure preserves draft with remount=${remount} newer=${newer || 'empty'}`, async ({ page }) => {
      const field = await openChat(page)
      await field.fill(BODY)
      await field.press('Enter')
      await expect.poll(() => calls(page)).toBe(1)
      if (remount) {
        await page.evaluate(() => { location.hash = '#/settings' })
        await expect(field).toHaveCount(0)
        await activateChat(page, PEER)
      }
      await expect(field).toHaveValue('')
      if (newer) await field.fill(newer)
      await page.evaluate(() => (window as any).__sendProbe.fail())
      await expect(page.getByText(/^Failed to send( message)?$/)).toBeVisible()
      await captureState(page)
      await expect(field).toHaveValue(new RegExp(BODY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      const recovered = await field.inputValue()
      if (newer) expect(recovered).toContain(newer)
      await expect.poll(() => page.evaluate(peer => (window as any).__chatStore.getState().getDraft(peer), PEER)).toBe(recovered)
      await field.fill(`${recovered}!`)
      await page.evaluate(() => { location.hash = '#/settings' })
      await expect(field).toHaveCount(0)
      await activateChat(page, PEER)
      await expect(field).toHaveValue(`${recovered}!`)
      expect(await calls(page)).toBe(1)
      console.log(JSON.stringify({ remount, newer, recovered, afterReturn: await field.inputValue(), calls: await calls(page) }))
    })
  }
}

test('failure after deleting newer input still retains the failed draft', async ({ page }) => {
  const field = await openChat(page)
  await field.fill(BODY)
  await field.press('Enter')
  await expect.poll(() => calls(page)).toBe(1)
  await field.fill('Oups')
  await field.fill('')
  await page.evaluate(() => (window as any).__sendProbe.fail())
  await expect(page.getByText(/^Failed to send( message)?$/)).toBeVisible()
  await captureState(page)
  await expect(field).toHaveValue(BODY)
  await expect.poll(() => page.evaluate(peer => (window as any).__chatStore.getState().getDraft(peer), PEER)).toBe(BODY)
})

// N1: captain chose waiting until another message's edit finishes.
for (const finish of ['cancel', 'save'] as const) {
 for (const room of [false, true]) {
  test(`failed text waits outside another message edit until ${finish}${room ? ' in room' : ''}`, async ({ page }) => {
    const field = room ? await openRoom(page) : await openChat(page)
    const expectText = (text: string) => room ? expect(field).toHaveText(text) : expect(field).toHaveValue(text)
    await field.fill('Good catch.')
    await field.press('Enter')
    await expect.poll(() => calls(page)).toBe(1)
    await page.evaluate(() => (window as any).__sendProbe.complete())
    await expect(page.locator('[data-message-body]').filter({ hasText: 'Good catch.' }).last()).toBeVisible()
    await field.fill(BODY)
    await field.press('Enter')
    await expect.poll(() => calls(page)).toBe(2)
    await field.press('ArrowUp')
    await expectText('Good catch.')
    await page.evaluate(() => (window as any).__sendProbe.fail())
    await expect(page.getByText('Failed to send message', { exact: true })).toBeVisible()
    await captureState(page)
    await expectText('Good catch.')
    await field.press(finish === 'cancel' ? 'Escape' : 'Enter')
    await expect(page.getByText('Editing message', { exact: true })).toHaveCount(0)
    await expectText(BODY)
    expect(await calls(page)).toBe(2)
    console.log(JSON.stringify({ finding: 'N1', finish, room, recovered: BODY, calls: await calls(page) }))
  })
 }
}

// N2: mention chips and outgoing references must survive the failed-send remount.
for (const newer of ['', 'Oups']) {
  test(`room mentions survive failed-send remount with newer=${newer || 'empty'}`, async ({ page }) => {
    const editor = await openRoom(page)
    await editor.click()
    await page.keyboard.type('@')
    await page.keyboard.press('Enter') // Select the real @all completion.
    await expect(editor.locator('[data-mention]')).toHaveCount(1)
    await editor.press('Enter')
    await expect.poll(() => calls(page)).toBe(1)
    const original = await page.evaluate(() => (window as any).__sendProbe.options[0].references)
    const originalBody = await page.evaluate(() => (window as any).__sendProbe.calls[0])
    const roomJid = await page.evaluate(() => (window as any).__roomStore.getState().activeRoomJid)
    await page.evaluate(() => { location.hash = '#/settings' })
    await expect(editor).toHaveCount(0)
    await page.evaluate(id => { location.hash = `#/rooms/${encodeURIComponent(id)}` }, roomJid)
    await expect(editor).toBeVisible()
    if (newer) await editor.fill(newer)
    await page.evaluate(() => (window as any).__sendProbe.fail())
    await expect(page.getByText('Failed to send message', { exact: true })).toBeVisible()
    await captureState(page)
    await expect(editor.locator('[data-mention]')).toHaveCount(1)
    await editor.press('End')
    await page.keyboard.insertText('!')
    await editor.press('Enter')
    await expect.poll(() => calls(page)).toBe(2)
    const retried = await page.evaluate(() => (window as any).__sendProbe.options[1].references)
    const retriedBody = await page.evaluate(() => (window as any).__sendProbe.calls[1])
    expect(retriedBody).toContain('!')
    if (newer) expect(retriedBody).toContain(newer)
    // A subsequent keystroke can move a mention. Its reference must describe
    // the actual outgoing body, not the caret position assumed by this test.
    expect(retried).toEqual(original.map((ref: any) => {
      const mentioned = originalBody.slice(ref.begin, ref.end)
      expect(retriedBody).toContain(mentioned)
      const begin = retriedBody.indexOf(mentioned)
      return { ...ref, begin, end: begin + mentioned.length }
    }))
    await page.evaluate(() => (window as any).__sendProbe.complete())
    console.log(JSON.stringify({ finding: 'N2', newer, original, retried, calls: await calls(page) }))
  })
}

for (const action of ['correction', 'retraction'] as const) {
  test(`failed action has chat-specific wording: ${action}`, async ({ page }) => {
    const field = await openChat(page)
    await field.fill(BODY)
    await field.press('Enter')
    await expect.poll(() => calls(page)).toBe(1)
    await page.evaluate(() => (window as any).__sendProbe.complete())
    await expect(page.locator('[data-message-body]').filter({ hasText: BODY })).toHaveCount(1)
    await expect(field).toHaveValue('')
    await page.evaluate(action => {
      const w = window as any
      w.__actionCalls = 0
      const method = action === 'correction' ? 'sendCorrection' : 'sendRetraction'
      w.__demoClient.messages[method] = async () => {
        w.__actionCalls++
        throw new Error('Socket not available')
      }
    }, action)
    await field.press('ArrowUp')
    await expect(page.getByText('Editing message', { exact: true })).toBeVisible()
    await expect(field).toHaveValue(BODY)
    const edited = action === 'correction' ? `${BODY} Oups` : ''
    await field.fill(edited)
    await field.press('Enter')
    await expect.poll(() => page.evaluate(() => (window as any).__actionCalls)).toBe(1)
    await expect(page.getByText(/^Failed to (send|edit|delete)( message)?$/)).toBeVisible()
    await captureState(page)
    const wording = action === 'correction' ? 'Failed to edit message' : 'Failed to delete message'
    await expect(page.getByText(wording, { exact: true })).toBeVisible()
    await expect(field).toHaveValue(edited)
    console.log(JSON.stringify({ action, wording, text: await field.inputValue() }))
  })
}
