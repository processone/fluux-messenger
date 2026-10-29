// Intent: FLM-256 — Enter, click and Enter must not resend a pending draft,
// even when settings navigation remounts the conversation (FLM-255).
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const BODY = 'Et il y a aussi ce nouveau ticket dolya: https://ejabberd.atlassian.net/browse/EJABS-4575'
const PEER = 'emma@fluux.chat'

async function openChat(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate((peer) => {
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
    location.hash = `#/messages/${encodeURIComponent(peer)}`
  }, PEER)
  // The demo initially opens Ava. Wait for the requested recipient's actual
  // composer, not merely any visible textarea while routing is still pending.
  const field = page.getByPlaceholder('Message Emma Wilson', { exact: true })
  await expect(field).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__chatStore.getState().activeConversationId)).toBe(PEER)
  return field
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
  await expect(page.getByText('Failed to send', { exact: true })).toBeVisible()
  console.log(JSON.stringify({ recoveredText: await field.inputValue(), calls: await calls(page), error: 'Failed to send' }))
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
