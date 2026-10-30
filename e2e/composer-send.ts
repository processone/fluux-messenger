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
    w.__sendProbe = { calls: [], settled: false }
    const original = client.messages.sendMessage.bind(client.messages)
    client.messages.sendMessage = async (...args: unknown[]) => {
      w.__sendProbe.calls.push(args[1])
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
